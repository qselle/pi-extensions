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
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.ANTHROPIC_API_KEY = "fixture-not-a-real-key";
process.env.PI_OFFLINE = "1";
globalThis.fetch = (() => { throw new Error("Network forbidden"); }) as unknown as typeof fetch;
const model = getModels("anthropic")[0]!;
const exhausted = contextBudget({ tokens: 0, contextWindow: model.contextWindow }).hard! + 10;

/** Run prompts against scripted assistant steps, each with its reported input tokens. */
async function scenario(name: string, notes: Record<string, string>, steps: { content: AssistantMessage["content"]; input: number }[], prompts: string[]) {
  const manager = SessionManager.create(root, join(root, name));
  manager.appendCustomEntry(JOURNAL_ENTRY, { version: 1, enabled: true, notes });
  const runtime = await createAgentSessionRuntime(async ({ sessionManager }) => {
    const services = await createAgentSessionServices({ cwd: root, agentDir,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] } });
    const result = await createAgentSessionFromServices({ services, sessionManager, model });
    return { ...result, services, diagnostics: [] };
  }, { cwd: root, agentDir, sessionManager: manager });
  const requests: string[] = [];
  const errors: string[] = [];
  try {
    runtime.session.extensionRunner.onError((error) => errors.push(error.error));
    await runtime.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
    runtime.session.agent.streamFunction = async (_model, context, options) => {
      const stream = new AssistantMessageEventStream();
      if (options?.signal?.aborted) {
        const aborted: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: "aborted",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end();
        return stream;
      }
      requests.push(JSON.stringify(context.messages));
      const step = steps[requests.length - 1];
      assert(step, "recovery continues exactly once");
      const stopReason = step.content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: step.content, stopReason,
        usage: { input: step.input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: step.input + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: stopReason, message });
      stream.end();
      return stream;
    };
    for (const prompt of prompts) await runtime.session.prompt(prompt);
    assert.deepEqual(errors, []);
    return { requests, branch: manager.getBranch() as any[] };
  } finally { runtime.session.dispose(); }
}

try {
  const bash = { content: [{ type: "toolCall" as const, id: "bash", name: "bash", arguments: { command: "true" } }], input: exhausted };
  const done = { content: [{ type: "text" as const, text: "Recovered from notes." }], input: 1000 };

  // Stale notes: the turn that spends the reserve rolls over and continues.
  const stale = await scenario("stale", { objective: "Recover after the emergency reserve." }, [bash, done], ["Original prompt with historical evidence."]);
  assert.equal(stale.requests.length, 2);
  assert(!stale.requests[1]!.includes("historical evidence"));
  assert(stale.requests[1]!.includes("Recover after the emergency reserve."));
  assert(stale.requests[1]!.includes(STALE_TEXT));
  const boundaries = stale.branch.filter((entry) => entry.type === "compaction");
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].details.stale, true);
  assert(stale.branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult")?.message.isError, "the tool is blocked before running");

  // No notes: the run stops once, and the next prompt can still save notes and recover.
  const write = { content: [{ type: "toolCall" as const, id: "notes", name: "context_notes", arguments: { action: "write", key: "objective", text: "Resume the interrupted work." } }], input: exhausted };
  const empty = await scenario("empty", {}, [bash, write, done], ["Original prompt with historical evidence.", "Save notes, then continue."]);
  assert.equal(empty.requests.length, 3);
  assert(empty.requests[1]!.includes("Save notes, then continue."), "the next prompt reaches the model");
  assert(!empty.requests[2]!.includes("historical evidence"));
  assert(empty.requests[2]!.includes("Resume the interrupted work."));
  assert(!empty.requests[2]!.includes(STALE_TEXT), "notes written in the spent reserve are fresh");
  console.log("emergency reserve rolls over to saved notes and continues");
} finally { await rm(root, { recursive: true, force: true }); }
