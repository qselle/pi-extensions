import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createReloadAllExtension, type ReloadRuntime } from "./index.ts";
import { describeStatus, identityFor, Registry } from "./store.ts";

const cleanup: Array<() => Promise<void>> = [];
let pid = 300;
async function environment() {
  const directory = await mkdtemp(join(tmpdir(), "pi-reload-runtime-"));
  cleanup.unshift(() => rm(directory, { recursive: true, force: true }));
  let time = 1_800_000_000_000;
  return { directory, now: () => time, advance: (ms: number) => { time += ms; }, store: new Registry(directory, () => time) };
}
async function runtime(env: Awaited<ReturnType<typeof environment>>, options: { mode?: string; refusal?: number; failure?: boolean; collision?: boolean; dropDispatch?: boolean; child?: boolean; identity?: ReturnType<typeof identityFor> } = {}) {
  const identity = options.identity ?? identityFor(++pid, randomUUID());
  let current: { events: Map<string, Function>; commands: Map<string, any>; tick: ReloadRuntime; nonce: string; ctx: any };
  let busy = false; let pending = false; let reloads = 0; let refs = options.refusal ?? 0; let collision = options.collision ?? false;
  const messages: string[] = []; const notices: string[] = []; const dispatches: Promise<void>[] = [];
  const dispatch = async (text: string) => {
    const match = /^\/reload-all (.*)$/.exec(text);
    if (match && !collision) await current.commands.get("reload-all")?.handler(match[1], current.ctx);
    else { const result = await current.events.get("input")?.({ text, source: "extension" }, current.ctx); if (result?.action !== "handled") throw new Error("Internal dispatch reached model"); }
  };
  const start = async () => {
    const events = new Map<string, Function>(); const commands = new Map<string, any>(); let tick!: ReloadRuntime;
    const nonce = randomUUID();
    const ctx = { mode: options.mode ?? "tui", isIdle: () => !busy, hasPendingMessages: () => pending, waitForIdle: async () => {},
      ui: { notify: (text: string) => notices.push(text) }, reload: async () => {
        reloads++;
        if (options.failure) throw new Error("Fixture failure");
        if (refs-- > 0) return;
        await events.get("session_shutdown")?.({ reason: "reload" }, ctx);
        await start();
      } };
    const previousChild = process.env.PI_SUBAGENT_CHILD;
    if (options.child) process.env.PI_SUBAGENT_CHILD = "1";
    try {
      createReloadAllExtension({ directory: env.directory, now: env.now, identity, runtimeNonce: nonce, intervalMs: 1_000_000,
        onRuntime: value => { tick = value; } })({
          on: (name: string, handler: Function) => events.set(name, handler), registerCommand: (name: string, command: any) => commands.set(name, command),
          getCommands: () => [...commands.keys()].map(name => ({ name: collision ? `${name}:1` : name, source: "extension" })),
          sendUserMessage: (text: string) => { messages.push(text); if (!options.dropDispatch) dispatches.push(Promise.resolve().then(() => dispatch(text))); },
        } as never);
    } finally { if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previousChild; }
    current = { events, commands, tick, nonce, ctx };
    await events.get("session_start")?.({}, ctx);
  };
  await start();
  const drain = async () => { while (dispatches.length) await Promise.all(dispatches.splice(0)); };
  const close = async () => { await drain(); await current.events.get("session_shutdown")?.({ reason: "quit" }, current.ctx); };
  cleanup.unshift(close);
  return { identity, messages, notices, close, reloads: () => reloads, nonce: () => current.nonce,
    busy: (value: boolean) => { busy = value; }, pending: (value: boolean) => { pending = value; }, collide: () => { collision = true; },
    tick: async () => { await current.tick?.tick(); await drain(); },
    emit: async (name: string) => { await current.events.get(name)?.({}, current.ctx); },
    command: async (args = "") => { await current.commands.get("reload-all")?.handler(args, current.ctx); await drain(); },
    dispatch, commands: () => current.commands,
  };
}
afterEach(async () => { for (const task of cleanup.splice(0)) await task(); });
test("broadcast reloads two idle runtimes once and only replacement nonces acknowledge success", async () => {
  const env = await environment(); const first = await runtime(env); const second = await runtime(env); const nonce = second.nonce();
  await first.command(); await second.tick();
  expect(first.reloads()).toBe(1); expect(second.reloads()).toBe(1); expect(second.nonce()).not.toBe(nonce);
  expect(await describeStatus(env.store, env.now())).toBe("2 sessions · 2 applied");
  for (let i = 0; i < 4; i++) { await first.tick(); await second.tick(); }
  expect(second.reloads()).toBe(1);
  await first.command("status"); expect(first.notices.at(-1)).toContain("2 applied");
});
test("busy, queued work and active nested dialogs delay dispatch", async () => {
  const env = await environment(); const first = await runtime(env); const second = await runtime(env);
  second.busy(true); await first.command(); await second.tick(); expect(second.messages).toHaveLength(0);
  second.busy(false); second.pending(true); await second.tick(); expect(second.messages).toHaveLength(0);
  second.pending(false); await second.emit("ui_prompt_start"); await second.emit("ui_prompt_start");
  await second.tick(); await second.emit("ui_prompt_end"); await second.tick(); expect(second.messages).toHaveLength(0);
  await second.emit("ui_prompt_end"); await second.tick(); expect(second.reloads()).toBe(1);
});
test("sessions opened after broadcast and RPC/child runtimes never participate", async () => {
  const env = await environment(); const first = await runtime(env);
  const rpc = await runtime(env, { mode: "rpc" }); const child = await runtime(env, { child: true });
  await first.command(); const late = await runtime(env); await late.tick(); await rpc.tick(); await child.tick();
  expect(late.reloads()).toBe(0); expect(rpc.reloads()).toBe(0); expect(child.commands().size).toBe(0);
  expect((await env.store.generation())?.targets).toHaveLength(1);
});
test("suspended registered sessions apply their snapshot on resume without PID signals", async () => {
  const env = await environment(); const first = await runtime(env); const second = await runtime(env);
  env.advance(60_000); await first.command();
  expect(await describeStatus(env.store, env.now())).toContain("1 unresponsive");
  await second.tick(); expect(second.reloads()).toBe(1);
  const reusedPid = await runtime(env, { identity: identityFor(second.identity.pid, randomUUID()) });
  await reusedPid.tick(); expect(reusedPid.reloads()).toBe(0);
});
test("refused reload retries only after backoff and safe idle, then confirms a new runtime", async () => {
  const env = await environment(); const first = await runtime(env); const second = await runtime(env, { refusal: 1 });
  await first.command(); await second.tick(); expect(second.reloads()).toBe(1);
  expect(await describeStatus(env.store, env.now())).toContain("1 waiting");
  await second.tick(); expect(second.reloads()).toBe(1);
  env.advance(1_001); second.busy(true); await second.tick(); expect(second.reloads()).toBe(1);
  second.busy(false); await second.tick(); expect(second.reloads()).toBe(2);
  expect(await describeStatus(env.store, env.now())).toBe("2 sessions · 2 applied");
});
test("repeated refusal and actual exceptions stop until another broadcast", async () => {
  const env = await environment(); const first = await runtime(env); const refused = await runtime(env, { refusal: 99 }); const failed = await runtime(env, { failure: true });
  await first.command(); await refused.tick(); await failed.tick();
  env.advance(1_001); await refused.tick(); env.advance(5_001); await refused.tick();
  for (let i = 0; i < 4; i++) { env.advance(10_000); await refused.tick(); await failed.tick(); }
  expect(refused.reloads()).toBe(3); expect(failed.reloads()).toBe(1);
  expect(await describeStatus(env.store, env.now())).toContain("2 failed");
  await first.command(); await failed.tick(); expect(failed.reloads()).toBe(2);
});
test("collisions block internal sends and private command fallthrough is consumed", async () => {
  const env = await environment(); const first = await runtime(env); const second = await runtime(env, { collision: true });
  await first.command(); await second.tick(); expect(second.messages).toHaveLength(0);
  expect(await describeStatus(env.store, env.now())).toContain("1 failed");
  await second.dispatch(`/reload-all __apply ${second.nonce()} ${randomUUID()}`);
  expect(second.reloads()).toBe(0);
});
test("unconfirmed void dispatch times out only during continuous idle and invalidates late commands", async () => {
  const env = await environment(); const first = await runtime(env); const second = await runtime(env, { dropDispatch: true });
  await first.command(); await second.tick();
  expect(await describeStatus(env.store, env.now())).toContain("1 dispatching");
  second.busy(true); env.advance(20_000); await second.tick();
  second.busy(false); await second.tick(); env.advance(9_000); await second.tick();
  expect((await env.store.target(second.identity.key))?.state).toBe("dispatching");
  second.pending(true); env.advance(20_000); await second.tick();
  second.pending(false); await second.tick(); env.advance(10_001); await second.tick();
  expect((await env.store.target(second.identity.key))?.state).toBe("failed");
  await second.dispatch(second.messages[0]!); await second.tick();
  expect(second.reloads()).toBe(0); expect(second.messages).toHaveLength(1);
});
