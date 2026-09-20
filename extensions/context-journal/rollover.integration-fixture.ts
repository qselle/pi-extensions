import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getModels } from "@earendil-works/pi-ai/compat";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, type CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { JOURNAL_ENTRY, historyMatches } from "./state.ts";
const root = await mkdtemp(join(tmpdir(), "pi-rollover-runtime-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.ANTHROPIC_API_KEY = "fixture-not-a-real-key";
let fetches = 0;
globalThis.fetch = (() => { fetches++; throw new Error("No network allowed in rollover fixture"); }) as unknown as typeof fetch;
const model = getModels("anthropic")[0]!;
const factory: CreateAgentSessionRuntimeFactory = async (options) => {
  const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1000 } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension] } });
  const result = await createAgentSessionFromServices({ services, sessionManager: options.sessionManager, model });
  return { ...result, services, diagnostics: [] };
};
let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
try {
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "Original objective: finish everything. " + "older evidence ".repeat(2000), timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Verified old evidence." }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
    usage: { input: 90000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 90100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  manager.appendMessage({ role: "user", content: "Second turn: verify the result. " + "recent details ".repeat(500), timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Checkpoint is ready." }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
    usage: { input: 95000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 95100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  manager.appendCustomEntry(JOURNAL_ENTRY, { version: 1, enabled: true, notes: { objective: "finish everything", next: "review implementation evidence" } });
  runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: manager });
  const runner = runtime.session.extensionRunner;
  await runner.emit({ type: "session_start", reason: "resume" });
  const before = await readFile(manager.getSessionFile()!, "utf8");
  const command = runner.getCommand("context-journal")!;
  await assert.rejects(command.handler("reset", runner.createCommandContext()), /stale/);
  const notes = runner.getAllRegisteredTools().find(tool => tool.definition.name === "context_notes")!.definition;
  await notes.execute("checkpoint", { action: "write", key: "next", text: "review implementation evidence" }, undefined, undefined, runner.createContext());
  await command.handler("reset", runner.createCommandContext());
  const entries = manager.getBranch();
  const compaction = entries.at(-1) as any;
  assert.equal(compaction.type, "compaction");
  assert.equal(compaction.fromHook, true);
  assert.equal(compaction.details.noSummary, true);
  const fresh = manager.buildSessionContext().messages;
  assert.equal(fresh.length, 1);
  assert(!JSON.stringify(fresh).includes("older evidence"));
  const request = await runner.emitContext(fresh);
  assert(JSON.stringify(request).includes("review implementation evidence"));
  assert.equal(runtime.session.getContextUsage()?.tokens, null);
  assert(historyMatches(entries, "older evidence").matches.length > 0);
  assert((await readFile(manager.getSessionFile()!, "utf8")).startsWith(before));
  const reopened = SessionManager.open(manager.getSessionFile()!);
  assert.equal(reopened.buildSessionContext().messages.length, 1);
  manager.appendMessage({ role: "user", content: "Continue now", timestamp: Date.now() });
  assert(JSON.stringify(manager.buildSessionContext().messages).includes("Continue now"));
  await assert.rejects(command.handler("reset", runner.createCommandContext()), /stale/);
  for (let turn = 0; turn < 2; turn++) {
    manager.appendMessage({ role: "user", content: "New evidence and remaining work ".repeat(1000), timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Verified second-cycle evidence. ".repeat(200) }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
      usage: { input: 95000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 95100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  await notes.execute("checkpoint-two", { action: "write", key: "next", text: "verify the second cycle" }, undefined, undefined, runner.createContext());
  await command.handler("reset", runner.createCommandContext());
  assert.equal(manager.getBranch().filter(entry => entry.type === "compaction").length, 2);
  assert.equal(fetches, 0);
  console.log("native no-summary compaction, journal injection, history and persistence verified");
} finally { runtime?.session.dispose(); await rm(root, { recursive: true, force: true }); }
