import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getModels } from "@earendil-works/pi-ai/compat";
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, SessionManager, SettingsManager, type CreateAgentSessionRuntimeFactory, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import planExtension from "./index.ts";

const root = await mkdtemp(join(tmpdir(), "pi-plan-anchor-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.ANTHROPIC_API_KEY = "fixture-not-a-real-key";
let fetches = 0;
globalThis.fetch = (() => { fetches++; throw new Error("No network allowed in the plan anchor fixture"); }) as unknown as typeof fetch;
const runs = { beforeAgentStart: 0, agentStart: 0 };
const observer = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", () => { runs.beforeAgentStart++; });
  pi.on("agent_start", () => { runs.agentStart++; });
};
const model = getModels("anthropic")[0]!;
const factory: CreateAgentSessionRuntimeFactory = async (options) => {
  const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [planExtension, observer] } });
  const result = await createAgentSessionFromServices({ services, sessionManager: options.sessionManager, model });
  return { ...result, services, diagnostics: [] };
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
try {
  const manager = SessionManager.inMemory(root);
  runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: manager });
  const { session } = runtime;
  const runner = session.extensionRunner;
  await runner.emit({ type: "session_start", reason: "startup" });

  manager.appendMessage({ role: "user", content: "Build the feature", timestamp: Date.now() });
  const args = { plan: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "in_progress" }, { step: "Verify", status: "pending" }] };
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "plan-1", name: "update_plan", arguments: args }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: Date.now() });
  const result = await runner.getToolDefinition("update_plan")!.execute("plan-1", args as never, undefined, undefined, runner.createToolContext("plan-1", undefined));
  manager.appendMessage({ role: "toolResult", toolCallId: "plan-1", toolName: "update_plan", content: result.content, details: result.details, isError: false, timestamp: Date.now() } as never);

  const anchors = () => manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "plan-context");
  const visibleAnchors = () => manager.buildSessionContext().messages.filter((message) => (message as { customType?: string }).customType === "plan-context");
  const compact = async (firstKeptEntryId: string) => {
    const compactionEntry = manager.getEntry(manager.appendCompaction("Summary", firstKeptEntryId, 1000))!;
    await runner.emit({ type: "session_compact", compactionEntry: compactionEntry as never, fromExtension: false, reason: "manual", willRetry: false });
  };

  manager.appendMessage({ role: "user", content: "Keep going", timestamp: Date.now() });
  await compact(manager.getLeafId()!);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(anchors().length, 1, "compaction that hides the plan appends one anchor");
  assert.equal(manager.getLeafEntry()?.type, "custom_message", "the idle anchor is appended directly to the session");
  assert.equal(session.isStreaming, false, "an idle anchor does not start a turn");
  assert.deepEqual(runs, { beforeAgentStart: 0, agentStart: 0 }, "an idle anchor does not start a turn");
  assert.equal(fetches, 0);

  // A second compaction that keeps the anchor and changes no plan state adds nothing.
  await compact(anchors()[0]!.id);
  assert.equal(anchors().length, 1, "a kept anchor is not duplicated");
  assert.equal(visibleAnchors().length, 1);

  // A second compaction that hides the anchor restates the plan once; the model still sees one copy.
  manager.appendMessage({ role: "user", content: "Continue again", timestamp: Date.now() });
  await compact(manager.getLeafId()!);
  await compact(manager.getLeafId()!);
  assert.equal(visibleAnchors().length, 1, "repeated compactions leave exactly one visible anchor");
  assert.equal(anchors().length, 2);
  await runner.emit({ type: "session_start", reason: "reload" });
  assert.equal(anchors().length, 2, "reload sees the anchor and adds nothing");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(runs, { beforeAgentStart: 0, agentStart: 0 });
  assert.equal(session.isStreaming, false);
  assert.equal(fetches, 0);
  console.log("idle plan anchors append without a turn and are never duplicated");
} finally {
  runtime?.session.dispose();
  await rm(root, { recursive: true, force: true });
}
