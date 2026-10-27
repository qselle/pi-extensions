import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { contextBudget, STALE_TEXT } from "./rollover.ts";
import { JOURNAL_ENTRY } from "./state.ts";

const root = await mkdtemp(join(tmpdir(), "pi-journal-exhausted-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.ANTHROPIC_API_KEY = "fixture-not-a-real-key";
process.env.PI_OFFLINE = "1";
globalThis.fetch = (() => { throw new Error("Network forbidden"); }) as unknown as typeof fetch;
const model = getModels("anthropic")[0]!;
const exhausted = contextBudget({ tokens: 0, contextWindow: model.contextWindow }).hard! + 10;
const manager = SessionManager.create(root, join(root, "sessions"));
manager.appendCustomEntry(JOURNAL_ENTRY, { version: 1, enabled: true, notes: { objective: "Recover after the emergency reserve." } });
const runtime = await createAgentSessionRuntime(async ({ sessionManager }) => {
  const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] } });
  const result = await createAgentSessionFromServices({ services, sessionManager, model });
  return { ...result, services, diagnostics: [] };
}, { cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: manager });
try {
  const requests: string[] = [];
  const errors: string[] = [];
  runtime.session.extensionRunner.onError((error) => errors.push(error.error));
  await runtime.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
  runtime.session.agent.streamFunction = async (_model, context) => {
    requests.push(JSON.stringify(context.messages));
    const step = requests.length;
    assert(step <= 2, "recovery continues exactly once");
    const content: AssistantMessage["content"] = step === 1 ? [{ type: "toolCall", id: "bash", name: "bash", arguments: { command: "true" } }] : [{ type: "text", text: "Recovered from notes." }];
    const input = step === 1 ? exhausted : 1000;
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason: step === 1 ? "toolUse" : "stop",
      usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    stream.end();
    return stream;
  };
  await runtime.session.prompt("Original prompt with historical evidence.");
  assert.deepEqual(errors, []);
  assert.equal(requests.length, 2);
  assert(!requests[1]!.includes("historical evidence"));
  assert(requests[1]!.includes("Recover after the emergency reserve."));
  assert(requests[1]!.includes(STALE_TEXT));
  const boundaries = manager.getBranch().filter((entry) => entry.type === "compaction") as any[];
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].details.stale, true);
  const blocked = manager.getBranch().find((entry: any) => entry.type === "message" && entry.message.role === "toolResult") as any;
  assert(blocked?.message.isError, "the tool is blocked before running");
  console.log("emergency reserve rolls over to stale notes and continues");
} finally { runtime.session.dispose(); await rm(root, { recursive: true, force: true }); }
