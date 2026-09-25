import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Registry, describeStatus, matches, processIdentity, runtimeDirectory, validId, type Generation, type Identity, type Target } from "./store.ts";

const COMMAND = "reload-all";
const PRIVATE_FORM = /^\/reload-all(?::\d+)?\s+__apply(?:\s|$)/;
const BACKOFF = [1_000, 5_000];
export interface ReloadRuntime { tick(): Promise<void> }
export interface ReloadOptions {
  directory?: string;
  identity?: Identity;
  now?: () => number;
  intervalMs?: number;
  runtimeNonce?: string;
  onRuntime?: (runtime: ReloadRuntime) => void;
}

export function createReloadAllExtension(options: ReloadOptions = {}) {
  return (pi: ExtensionAPI): void => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;
    const now = options.now ?? Date.now;
    const nonce = options.runtimeNonce ?? randomUUID();
    const identity = options.identity ?? processIdentity();
    let registry: Registry | undefined;
    let target: Target | undefined;
    let context: ExtensionContext | undefined;
    let active = false;
    let checking = false;
    let applying = false;
    let promptDepth = 0;
    let queued: string | undefined;
    let queuedIdleSince: number | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastHeartbeat = 0;
    let mutation = Promise.resolve();
    let warned = false;
    const warn = (message: string) => context?.ui.notify(message, "warning");
    const safe = (ctx = context) => active && !!ctx && ctx.mode === "tui" && promptDepth === 0 && ctx.isIdle() && !ctx.hasPendingMessages();
    const save = async (change: (record: Target) => Target): Promise<boolean> => {
      let saved = false;
      mutation = mutation.catch(() => {}).then(async () => {
        if (!registry || !target) return;
        const stored = await registry.target(identity.key);
        // A replacement runtime owns the file as soon as its handshake lands.
        if (!stored || stored.runtimeNonce !== nonce) return;
        const next = change(stored);
        await registry.saveTarget(next);
        target = next;
        saved = true;
      });
      await mutation;
      return saved;
    };
    const requestedHere = (generation: Generation) => generation.targets.some((recipient) => matches(recipient, { ...identity, runtimeNonce: nonce }));
    const fail = async (generation: string, failure: Target["failure"]) => {
      await save((record) => ({ ...record, generation, state: "failed", failure, requestRuntimeNonce: undefined, retryAt: undefined, updatedAt: now() }));
    };

    const apply = async (generationId: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (!safe(ctx) || applying || !registry) return;
      applying = true;
      try {
        await ctx.waitForIdle();
        if (!safe(ctx)) return;
        const generation = await registry.generation();
        if (!generation || generation.id !== generationId || !requestedHere(generation)) return;
        if (target?.generation === generation.id && ["applied", "failed", "requested"].includes(target.state)) return;
        if (target?.generation === generation.id && (target.retryAt ?? 0) > now()) return;
        const claimed = await save((record) => ({ ...record, generation: generation.id, state: "requested", requestRuntimeNonce: nonce,
          attempts: record.generation === generation.id ? record.attempts + 1 : 1, retryAt: undefined, failure: undefined, updatedAt: now() }));
        if (!claimed) { active = false; return; }
        // A dialog or queued continuation can appear while registry I/O awaits.
        // Recheck immediately before calling Pi, without another async gap.
        if (!safe(ctx)) {
          await save((record) => ({ ...record, state: "waiting", requestRuntimeNonce: undefined, attempts: Math.max(0, record.attempts - 1), updatedAt: now() }));
          return;
        }
        try { await ctx.reload(); }
        catch {
          await fail(generation.id, "exception");
          warn("Reload failed; inspect /reload-all status and send a new broadcast to retry.");
          return;
        }
        const after = await registry.target(identity.key);
        if (after?.generation === generation.id && after.state === "applied" && after.runtimeNonce !== nonce) return;
        // Pi can resolve reload() while refusing it during a busy boundary.
        // A new runtime is the only success proof; back off instead of spinning.
        const attempts = target?.attempts ?? 1;
        if (attempts >= 3 || !active) {
          await fail(generation.id, "refused");
          warn("Reload was not confirmed; send /reload-all again when the session is ready.");
        } else {
          await save((record) => ({ ...record, state: "waiting", requestRuntimeNonce: undefined,
            retryAt: now() + BACKOFF[attempts - 1]!, updatedAt: now() }));
        }
      } finally { applying = false; }
    };

    const tick = async (): Promise<void> => {
      if (!active || checking || applying || !registry || !target) return;
      checking = true;
      try {
        if (now() - lastHeartbeat >= 5_000) {
          await save((record) => ({ ...record, updatedAt: now() }));
          lastHeartbeat = now();
        }
        const generation = await registry.generation();
        if (!active || !generation || !requestedHere(generation)) return;
        if (target.generation === generation.id && ["applied", "failed", "requested"].includes(target.state)) return;
        if (target.generation !== generation.id) await save((record) => ({ ...record, generation: generation.id, state: "waiting", attempts: 0,
          retryAt: undefined, requestRuntimeNonce: undefined, failure: undefined, updatedAt: now() }));
        if (queued === generation.id) {
          // sendUserMessage is void: Pi can absorb an asynchronous dispatch
          // error. Do not leave a silent permanent queue claim in that case.
          // Busy time never counts toward this confirmation timeout.
          if (!safe()) { queuedIdleSince = undefined; return; }
          queuedIdleSince ??= now();
          if (now() - queuedIdleSince >= 10_000) {
            queued = undefined; queuedIdleSince = undefined;
            await fail(generation.id, "command");
            warn("Reload dispatch was not confirmed; inspect /reload-all status and send a new broadcast to retry.");
          }
          return;
        }
        if (!safe() || (target.retryAt ?? 0) > now()) return;
        // Native Pi renames every duplicate command. Verify resolution before
        // dispatch; the input sink below protects against a later collision.
        if (!pi.getCommands().some((command) => command.name === COMMAND && command.source === "extension")) {
          await fail(generation.id, "command");
          warn("Reload command is duplicated or unavailable; resolve the command conflict first.");
          return;
        }
        queued = generation.id;
        queuedIdleSince = now();
        await save((record) => ({ ...record, state: "dispatching", updatedAt: now() }));
        if (!active) return;
        try {
          pi.sendUserMessage(`/${COMMAND} __apply ${nonce} ${generation.id}`, { deliverAs: "followUp", expandPromptTemplates: true });
        } catch {
          queued = undefined;
          queuedIdleSince = undefined;
          await fail(generation.id, "command");
        }
      } catch {
        if (!warned) { warned = true; warn("Reload coordination is unavailable; inspect its private registry and run /reload."); }
      } finally { checking = false; }
    };
    options.onRuntime?.({ tick });

    pi.on("input", async (event) => {
      if (!PRIVATE_FORM.test(event.text)) return { action: "continue" };
      if (queued) {
        const generation = queued; queued = undefined; queuedIdleSince = undefined;
        // The sink must consume coordination text even if the registry failed.
        await fail(generation, "command").catch(() => {});
      }
      return { action: "handled" };
    });
    pi.on("ui_prompt_start", () => { promptDepth++; });
    pi.on("ui_prompt_end", () => { promptDepth = Math.max(0, promptDepth - 1); });

    pi.registerCommand(COMMAND, {
      description: "Reload all participating Pi terminals; /reload-all status shows progress",
      handler: async (args, ctx) => {
        const fields = args.trim().split(/\s+/).filter(Boolean);
        if (fields[0] === "__apply") {
          const generation = fields.length === 3 && fields[1] === nonce && validId(fields[2]) ? fields[2] : undefined;
          if (!generation || queued !== generation) return;
          queued = undefined;
          queuedIdleSince = undefined;
          await apply(generation, ctx);
          return;
        }
        if (!active || !registry || ctx.mode !== "tui") { ctx.ui.notify("Reload-all participates only in top-level Pi terminals.", "info"); return; }
        try {
          if (fields.length === 1 && fields[0] === "status") { ctx.ui.notify(await describeStatus(registry, now()), "info"); return; }
          if (fields.length) { ctx.ui.notify("Usage: /reload-all [status]", "warning"); return; }
          await save((record) => ({ ...record, updatedAt: now() }));
          const targets = await registry.targets();
          const generation: Generation = { version: 1, id: randomUUID(), createdAt: now(), issuer: identity.key,
            targets: targets.map(({ key, pid, processNonce, runtimeNonce }) => ({ key, pid, processNonce, runtimeNonce })) };
          await registry.publish(generation);
          ctx.ui.notify(`Reload requested for ${targets.length} Pi sessions · busy sessions wait · /reload-all status`, "info");
          // Retain a command-capable context for the issuing session. Other
          // runtimes acquire theirs through the guarded private dispatch.
          await apply(generation.id, ctx);
        } catch { ctx.ui.notify("Reload broadcast failed; check registry permissions and capacity.", "error"); }
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      if (ctx.mode !== "tui") return;
      context = ctx;
      try {
        registry ??= new Registry(options.directory ?? runtimeDirectory(), now);
        await registry.initialize();
        const [stored, generation] = await Promise.all([registry.target(identity.key), registry.generation()]);
        const completing = generation && stored?.state === "requested" && stored.requestRuntimeNonce === stored.runtimeNonce
          && stored.runtimeNonce !== nonce && stored.processNonce === identity.processNonce && generation.id === stored.generation
          && generation.targets.some((recipient) => matches(recipient, stored));
        target = { ...identity, version: 1, runtimeNonce: nonce, updatedAt: now(), state: "ready", attempts: 0,
          ...(stored?.runtimeNonce === nonce ? stored : {}),
          ...(completing ? { generation: generation.id, state: "applied" as const, attempts: stored.attempts } : {}),
        };
        target.runtimeNonce = nonce; target.updatedAt = now();
        await registry.saveTarget(target);
        active = true; lastHeartbeat = now();
        if (timer) clearInterval(timer);
        timer = setInterval(() => { void tick(); }, options.intervalMs ?? 1000);
        timer.unref?.();
        if (completing) ctx.ui.notify("Reload confirmed · /reload-all status", "info");
      } catch {
        active = false;
        ctx.ui.notify("Reload-all is unavailable: its coordination directory must be private and owned by this user.", "warning");
      }
    });
    pi.on("session_shutdown", async (event) => {
      active = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      queued = undefined;
      queuedIdleSince = undefined;
      await mutation.catch(() => {});
      if (event.reason === "quit" && registry) {
        const stored = await registry.target(identity.key);
        if (stored?.runtimeNonce === nonce) await registry.remove(identity.key);
      }
    });
  };
}

export default createReloadAllExtension();
