import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeManualTitle } from "./engine.ts";
import { herdrRequest, type HerdrRequest } from "./herdr-client.ts";

const ENTRY = "session-title:tab-link";
const USAGE = "Usage: /title tab [status|link|auto|off]";
interface Ownership { key: string; label: string }
interface State { version: 1; enabled?: boolean; owner?: Ownership; paused?: string }
interface Work { title: string; claim: boolean; epoch: number; revision: number }

export interface TabLinkOptions {
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
  request?: HerdrRequest;
}

function storedState(value: unknown): State | undefined {
  if (!value || typeof value !== "object") return;
  const data = value as State;
  if (data.version !== 1 || (data.enabled !== undefined && typeof data.enabled !== "boolean")) return;
  if (data.owner && (typeof data.owner.key !== "string" || typeof data.owner.label !== "string")) return;
  if (data.paused !== undefined && typeof data.paused !== "string") return;
  return { version: 1, enabled: data.enabled, owner: data.owner, paused: data.paused };
}

function paneInfo(value: any, expected: string): { tab_id: string; terminal_id: string } {
  const pane = value?.pane;
  if (value?.type !== "pane_info" || pane?.pane_id !== expected
    || typeof pane?.tab_id !== "string" || !pane.tab_id
    || typeof pane?.terminal_id !== "string" || !pane.terminal_id) throw new Error("Unsupported Herdr pane response");
  return pane;
}

function tabInfo(value: any, expected: string): { label: string; pane_count: number } {
  const tab = value?.tab;
  if (value?.type !== "tab_info" || tab?.tab_id !== expected || typeof tab?.label !== "string"
    || !Number.isInteger(tab?.pane_count) || tab.pane_count < 1) throw new Error("Unsupported Herdr tab response");
  return tab;
}

/** Herdr labels an unnamed tab with the ordinal encoded in its tab ID. */
function isDefaultOrdinalLabel(label: string, tabId: string): boolean {
  return /^:t([1-9]\d*)$/.exec(tabId.slice(tabId.lastIndexOf(":")))?.[1] === label;
}

/** Tab link follows session names without owning OSC titles or making model requests. */
export function registerTabLink(pi: ExtensionAPI, options: TabLinkOptions = {}) {
  const env = options.env ?? process.env;
  const request = options.request ?? herdrRequest;
  let state: State = { version: 1 };
  // In-process observations outrank an older session's saved ownership.
  let live: Pick<State, "owner" | "paused"> = {};
  let context: ExtensionContext | undefined;
  let saved = "";
  let epoch = 0;
  let revision = 0;
  let pending: Work | undefined;
  let activeWork: Work | undefined;
  let running = Promise.resolve();
  let controller: AbortController | undefined;
  let status = "waiting for session start";

  const unavailable = (ctx?: ExtensionContext) => {
    if (ctx?.mode !== "tui") return "inactive outside Pi's TUI";
    if (env.PI_SUBAGENT_CHILD === "1") return "inactive in a child agent";
    if (env.HERDR_ENV !== "1") return "inactive outside Herdr";
    if (!env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) return "inactive: Herdr socket or pane identity is missing";
    return undefined;
  };
  const persist = () => {
    const serialized = JSON.stringify(state);
    if (serialized === saved) return;
    pi.appendEntry(ENTRY, structuredClone(state));
    saved = serialized;
  };
  const cancel = () => {
    epoch += 1;
    pending = undefined;
    controller?.abort();
    controller = undefined;
  };
  const idle = async () => {
    let observed: Promise<void>;
    do { observed = running; await observed; } while (observed !== running);
  };

  const sync = async (work: Work) => {
    const active = () => work.epoch === epoch;
    const latest = () => active() && work.revision === revision;
    const abort = new AbortController();
    controller = abort;
    const path = env.HERDR_SOCKET_PATH!;
    const paneId = env.HERDR_PANE_ID!;
    try {
      // Resolve the pane on every update: HERDR_TAB_ID can become stale after a move.
      const pane = paneInfo(await request(path, "pane.get", { pane_id: paneId }, abort.signal), paneId);
      if (!latest()) return;
      const tab = tabInfo(await request(path, "tab.get", { tab_id: pane.tab_id }, abort.signal), pane.tab_id);
      if (!latest()) return;
      if (tab.pane_count !== 1) {
        if (pending) pending.claim = false;
        status = "paused: split tabs keep their shared label";
        return;
      }
      // The terminal identity prevents a restored session from claiming a reused pane ID.
      const key = createHash("sha256").update(`${path}\0${pane.terminal_id}\0${pane.tab_id}`).digest("hex");
      const known = live.owner?.key === key || live.paused === key ? live : state;
      const owned = known.owner?.key === key && known.owner.label === tab.label;
      const defaultOrdinal = isDefaultOrdinalLabel(tab.label, pane.tab_id);
      const paused = known.paused === key && !defaultOrdinal;
      const ownershipLost = !owned
        && ((tab.label !== "" && !defaultOrdinal) || known.owner?.key === key);
      if (!work.claim && (paused || ownershipLost)) {
        state.owner = undefined;
        state.paused = key;
        live = { paused: key };
        persist();
        status = "preserving the Herdr label; /title tab link to follow Pi";
        return;
      }
      if (tab.label !== work.title) {
        // Recheck pane membership immediately before the write. Herdr has no
        // conditional rename, so a concurrent external edit can still race it.
        const current = paneInfo(await request(path, "pane.get", { pane_id: paneId }, abort.signal), paneId);
        if (!latest()) return;
        if (current.tab_id !== pane.tab_id || current.terminal_id !== pane.terminal_id) {
          status = "pane moved during update; waiting for the next title event";
          return;
        }
        const updated = tabInfo(await request(path, "tab.rename", { tab_id: pane.tab_id, label: work.title }, abort.signal), pane.tab_id);
        if (!active()) return;
        if (updated.label !== work.title) throw new Error("Herdr did not accept the title");
      }
      if (!active()) return;
      state.owner = { key, label: work.title };
      live = { owner: state.owner };
      state.paused = undefined;
      persist();
      if (pending) pending.claim = false;
      if (latest()) status = `linked: “${work.title}”`;
    } catch (error) {
      if (active()) status = error instanceof Error ? error.message : "Herdr update failed";
    } finally {
      if (controller === abort) controller = undefined;
    }
  };

  const queue = (ctx: ExtensionContext, title: string | undefined, claim = false): Promise<void> => {
    context = ctx;
    const reason = unavailable(ctx);
    if (reason || !(state.enabled ?? options.enabled ?? true)) {
      status = reason ?? "off";
      return Promise.resolve();
    }
    const clean = title && normalizeManualTitle(title);
    if (!clean) {
      // A cleared name must invalidate an older queued write too.
      revision += 1;
      pending = undefined;
      status = "waiting for a Pi session name";
      return Promise.resolve();
    }
    pending = {
      title: clean,
      claim: claim || pending?.claim === true || (activeWork?.epoch === epoch && activeWork.claim),
      epoch,
      revision: ++revision,
    };
    running = running.then(async () => {
      const work = pending;
      pending = undefined;
      if (!work) return;
      activeWork = work;
      try { await sync(work); }
      finally { activeWork = undefined; }
    });
    return running;
  };

  const start = (ctx: ExtensionContext) => {
    cancel();
    // Carry ownership between sessions in this process; /reload and resume use
    // non-context session entries. An explicit off setting belongs to its session.
    state = { version: 1, owner: state.owner, paused: state.paused };
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      const restored = storedState(entry.data);
      if (restored) state = restored;
    }
    saved = "";
    void queue(ctx, pi.getSessionName());
  };
  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("session_tree", (_event, ctx) => start(ctx));
  pi.on("session_info_changed", (event, ctx) => { void queue(ctx, event.name); });
  pi.on("agent_start", (_event, ctx) => { void queue(ctx, pi.getSessionName()); });
  pi.on("session_shutdown", () => { cancel(); context = undefined; status = "stopped"; });

  return {
    status: () => `Tab link: ${unavailable(context) ?? status}`,
    command: async (args: string, ctx: ExtensionCommandContext) => {
      let commandEpoch = epoch;
      const action = args.trim().toLowerCase() || "status";
      if (!["status", "link", "auto", "off"].includes(action)) {
        ctx.ui.notify(USAGE, "error");
        return;
      }
      if (action === "off") {
        cancel();
        commandEpoch = epoch;
        state.enabled = false;
        persist();
        status = "off (the current tab label is kept)";
      } else if (action === "link" || action === "auto") {
        const reason = unavailable(ctx);
        if (reason) { ctx.ui.notify(`Tab link: ${reason}`, "info"); return; }
        if (action === "link" && !normalizeManualTitle(pi.getSessionName() ?? "")) {
          ctx.ui.notify("Name this Pi session first with /rename <text>.", "info");
          return;
        }
        state.enabled = true;
        if (action === "auto") { state.paused = undefined; live.paused = undefined; }
        persist();
        await queue(ctx, pi.getSessionName(), action === "link");
        await idle();
      } else {
        await idle();
      }
      if (commandEpoch !== epoch) return;
      ctx.ui.notify(`Tab link: ${unavailable(ctx) ?? status}`, "info");
    },
  };
}
