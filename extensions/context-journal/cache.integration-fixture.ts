import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { JOURNAL_ENTRY, JOURNAL_HEADER } from "./state.ts";

const root = await mkdtemp(join(tmpdir(), "pi-journal-cache-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.ANTHROPIC_API_KEY = "fixture-not-a-real-key";
process.env.PI_OFFLINE = "1";
globalThis.fetch = (() => { throw new Error("Network forbidden"); }) as unknown as typeof fetch;
const model = getModels("anthropic")[0]!;
const reminderTokens = Math.floor(model.contextWindow * 0.9) - Math.min(6144, Math.floor(model.contextWindow * 0.1)) + 100;
const manager = SessionManager.create(root, join(root, "sessions"));
manager.appendCustomEntry(JOURNAL_ENTRY, { version: 1, enabled: true, notes: {} });
const runtime = await createAgentSessionRuntime(async ({ sessionManager }) => {
  const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] } });
  const result = await createAgentSessionFromServices({ services, sessionManager, model });
  return { ...result, services, diagnostics: [] };
}, { cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: manager });
try {
  const requests: unknown[][] = [];
  await runtime.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
  runtime.session.agent.streamFunction = async (_model, context) => {
    requests.push(structuredClone(context.messages));
    const step = requests.length;
    const content: AssistantMessage["content"] = step === 1
      ? [{ type: "toolCall", id: "notes", name: "context_notes", arguments: { action: "write", key: "objective", text: "Keep the cached request prefix stable." } }]
      : step === 2 ? [{ type: "toolCall", id: "budget", name: "context_budget", arguments: {} }]
      : [{ type: "text", text: "Done." }];
    const input = step >= 2 ? reminderTokens : 1000;
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: step, content, stopReason: step <= 2 ? "toolUse" : "stop",
      usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    stream.end();
    return stream;
  };
  await runtime.session.prompt("Write a note, then check the budget.");
  await runtime.session.prompt("Continue.");
  assert.equal(requests.length, 4);
  for (let index = 1; index < requests.length; index++) {
    const previous = requests[index - 1]!;
    assert.deepEqual(requests[index]!.slice(0, previous.length), previous, `request ${index + 1} must extend request ${index}`);
  }
  const texts = requests.map((request) => JSON.stringify(request));
  assert(texts.every((text) => !text.includes(JOURNAL_HEADER)), "notes are not appended to requests");
  assert(!texts[1]!.includes("approaching its working limit"));
  assert(texts[2]!.includes("approaching its working limit"), "the reminder follows the turn that crossed the threshold");
  assert.equal(texts[3]!.split("approaching its working limit").length, 2, "the reminder is persisted once");
  console.log("journal requests keep a stable cached prefix");
} finally { runtime.session.dispose(); await rm(root, { recursive: true, force: true }); }
