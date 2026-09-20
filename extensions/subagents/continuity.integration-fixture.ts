import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getModels } from "@earendil-works/pi-ai/compat";
import register from "./index.ts";
import { createAgentSessionServices, createAgentSessionFromServices, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
import { createChildContext, checkpointFile } from "./context.ts";
import { SubagentCoordinator, type SavedAgent } from "./coordinator.ts";
import { restoreAgents, SUBAGENT_STATE } from "./persistence.ts";
import type { AgentClient, RpcEvent } from "./rpc.ts";

let networkAttempts = 0;
globalThis.fetch = (() => { networkAttempts++; throw new Error("Native child continuity fixture forbids network"); }) as unknown as typeof fetch;
const root = await mkdtemp(join(tmpdir(), "pi-child-continuity-"));
const answer = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }], api: "openai-responses" as const, provider: "test", model: "fixture", timestamp: Date.now(), stopReason: "stop" as const, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
class Client implements AgentClient {
  prompts: string[] = []; steers: string[] = []; stops = 0; clears = 0; starts = 0;
  listeners: ((event: RpcEvent) => void)[] = [];
  constructor(readonly file: string) {}
  async start() { this.starts++; }
  async prompt(text: string) { this.prompts.push(text); SessionManager.open(this.file).appendMessage({ role: "user", content: text, timestamp: Date.now() }); }
  async steer(text: string) { this.steers.push(text); }
  async abort() {}
  async clearQueue() { this.clears++; }
  async stop() { this.stops++; }
  onEvent(listener: (event: RpcEvent) => void) { this.listeners.push(listener); return () => {}; }
  onExit() { return () => {}; }
  stderr() { return ""; }
  emit(event: RpcEvent) { this.listeners.forEach((listener) => listener(event)); }
  complete(text: string) { const message = answer(text); SessionManager.open(this.file).appendMessage(message); this.emit({ type: "message_end", message }); this.emit({ type: "agent_settled" }); }
}
try {
  const parent = SessionManager.create(root, root); parent.appendMessage(answer("Parent decision"));
  const ctx = { cwd: root, sessionManager: parent };
  // Summary must cross a real disk boundary even before any child response.
  const summary = await createChildContext(ctx, "summary", "Exact summary handoff");
  assert(JSON.stringify(SessionManager.open(summary.sessionFile).buildSessionContext()).includes("Exact summary handoff"));
  assert(existsSync(summary.sessionFile)); await summary.cleanup();
  const clients: Client[] = [];
  let notifications = 0;
  const make = () => new SubagentCoordinator({ createRuntime: async (request) => {
    const context = await createChildContext(ctx, request.contextMode, undefined, request.resume);
    const client = new Client(context.sessionFile); clients.push(client);
    return { client, checkpoint: context.checkpoint, cleanup: context.cleanup };
  }, hooks: { onCompletion: () => { notifications++; } } });
  const first = make(); first.startSession();
  await first.spawn({ name: "Review", task: "Review persistence", contextMode: "fresh", cwd: root });
  first.queue("Review", "Read-only queued note");
  assert.equal(clients[0]!.prompts.length, 1); assert.equal(clients[0]!.steers.length, 0);
  let saved = await first.suspend();
  assert.equal(clients[0]!.stops, 1); assert.equal(saved[0]!.agent.status, "stopped");
  assert.equal(saved[0]!.inbox.length, 1); assert(saved[0]!.resume);
  const stopped = saved[0]!.resume!;
  const second = make(); second.restore(saved); assert.equal(clients.length, 1, "restore must not start a process");
  await second.send("Review", "Continue now", ctx);
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[1]!.prompts, ["Read-only queued note\n\nContinue now"]);
  assert.equal(second.list()[0]!.queued, 0);
  clients[1]!.complete("Final review");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(notifications, 1);
  saved = await second.suspend();
  // A queued automatic message is not acknowledged until actually persisted.
  const state = { type: "custom", customType: SUBAGENT_STATE, data: { version: 1, agents: saved } };
  const unread = restoreAgents([state]); assert.equal(unread[0]!.delivery, "none");
  const acknowledged = restoreAgents([state, { type: "custom_message", customType: "subagent-completion", details: saved[0]!.agent }]);
  assert.equal(acknowledged[0]!.delivery, "wait");
  const third = make(); third.restore(unread);
  assert.equal(third.list()[0]!.unread, true); assert.equal(third.read("Review").output, "Final review");
  assert.equal(third.list()[0]!.unread, false); assert.equal(notifications, 1, "restore/read must not duplicate delivery");
  third.queue("Review", "Cancelled pending instruction"); await third.interrupt("Review");
  await third.send("Review", "New instruction", ctx);
  assert.deepEqual(clients[2]!.prompts, ["New instruction"]);
  third.queue("Review", "Discard before abort"); await third.interrupt("Review");
  assert.equal(clients[2]!.clears, 2); assert.equal(third.list()[0]!.queued, 0);
  // The old checkpoint remains pinned before later follow-ups and final output.
  const earlier = await createChildContext(ctx, "fresh", undefined, stopped);
  const earlierText = JSON.stringify(SessionManager.open(earlier.sessionFile).buildSessionContext());
  assert(!earlierText.includes("Final review")); assert(!earlierText.includes("Continue now"));
  await earlier.cleanup();
  const resume = third.checkpoint()[0]!.resume!;
  const path = await checkpointFile(ctx, resume);
  await third.close("Review"); assert(!existsSync(path));
  await assert.rejects(checkpointFile(ctx, { ...resume, directory: "../outside" }), /Invalid/);
  const outside = join(root, "outside"); await symlink(root, outside);
  const parentFile = parent.getSessionFile()!;
  const link = join(`${parentFile}.subagents`, "pi-subagent-context-link"); await symlink(root, link);
  await assert.rejects(checkpointFile(ctx, { ...resume, directory: "pi-subagent-context-link", file: parentFile.split("/").at(-1)! }), /unsafe/);
  assert.deepEqual(restoreAgents([{ ...state, data: { version: 1, agents: [{ ...saved[0], resume: { ...resume, directory: "../escape" } }] } }]), []);
  // Exercise actual extension startup/shutdown/reload hooks and persisted custom
  // entries through Pi, while replacing only the external child RPC process.
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = getModels("anthropic")[0]!;
  let native!: SubagentCoordinator;
  let nativeContext: any;
  const nativeClients: Client[] = [];
  const errors: unknown[] = [];
  const nativeParent = SessionManager.create(root, join(root, "native-parent"));
  nativeParent.appendMessage(answer("Persist this parent"));
  const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        native = register(pi, { createClient: (options) => {
          const file = options.args[options.args.indexOf("--session") + 1]!;
          const client = new Client(file); nativeClients.push(client); return client;
        }, registerCard: (() => ({ invalidate() {}, unregister() {} })) as any })!;
        pi.on("session_start", (_event, ctx) => { nativeContext = ctx; });
      }] } });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: nativeParent, model });
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  try {
    await native.spawn({ name: "Native child", task: "Validate reload", contextMode: "fresh", cwd: root, parentContext: nativeContext });
    native.queue("Native child", "Queued before reload");
    await session.reload();
    assert.equal(nativeClients.length, 1); assert.equal(nativeClients[0]!.stops, 1);
    assert.equal(native.list()[0]!.status, "stopped"); assert.equal(native.list()[0]!.queued, 1);
    const disk = SessionManager.open(nativeParent.getSessionFile()!);
    assert.equal(restoreAgents(disk.getBranch())[0]!.agent.status, "stopped");
    await native.send("Native child", "Explicit continuation", nativeContext);
    assert.equal(nativeClients.length, 2);
    assert.deepEqual(nativeClients[1]!.prompts, ["Queued before reload\n\nExplicit continuation"]);
    await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal(nativeClients[1]!.stops, 1);
    assert.deepEqual(errors, []);
  } finally { session.dispose(); }
  assert.equal(networkAttempts, 0);
  console.log("Saved child conversations resume explicitly; queue cancellation, pinned branches and unread delivery verified");
} finally { await rm(root, { recursive: true, force: true }); }
