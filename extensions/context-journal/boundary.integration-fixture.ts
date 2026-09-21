import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai/compat";
import { getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { JOURNAL_ENTRY, historyMatches } from "./state.ts";

const root = await mkdtemp(join(tmpdir(), "pi-journal-boundary-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.ANTHROPIC_API_KEY = "fixture-not-a-real-key";
process.env.PI_OFFLINE = "1";
globalThis.fetch = (() => { throw new Error("Network forbidden"); }) as unknown as typeof fetch;
const model = getModels("anthropic")[0]!;
try {
  for (const outcome of ["stop", "error", "aborted"] as const) {
    const manager = SessionManager.create(root, join(root, outcome));
    manager.appendCustomEntry(JOURNAL_ENTRY, { version: 1, enabled: true, notes: {} });
    const lifecycle: string[] = [];
    let followUpSent = false;
    const runtime = await createAgentSessionRuntime(async ({ sessionManager }) => {
      const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension, (pi) => {
          pi.on("agent_start", () => { lifecycle.push("start"); });
          pi.on("agent_settled", (_event, ctx) => {
            assert(ctx.isIdle());
            lifecycle.push("settled-first");
            if (outcome === "stop" && !followUpSent) { followUpSent = true; pi.sendUserMessage("Inspect the queued follow-up."); }
            assert(ctx.isIdle(), "settled handlers must not start a reentrant run");
          });
          pi.on("agent_settled", () => { lifecycle.push("settled-last"); });
        }] } });
      const result = await createAgentSessionFromServices({ services, sessionManager, model });
      return { ...result, services, diagnostics: [] };
    }, { cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: manager });
    try {
      const errors: string[] = [];
      const events: string[] = [];
      const requests: string[] = [];
      runtime.session.extensionRunner.onError((error) => errors.push(error.error));
      await runtime.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
      runtime.session.subscribe((event) => { events.push(event.type); });
      runtime.session.agent.streamFunction = async (_model, context) => {
        requests.push(JSON.stringify(context.messages));
        assert(getCurrentSystemPrompt(context.messages).length > 0, "context handlers must preserve the native prompt");
        assert(getCurrentTools(context.messages).some((tool) => tool.name === "read"), "context handlers must preserve native tools");
        const step = requests.length;
        assert(step <= (outcome === "stop" ? 5 : 3), "rollover must not cause an endless continuation loop");
        const content: AssistantMessage["content"] = step === 1
          ? [{ type: "toolCall", id: "notes", name: "context_notes", arguments: { action: "write", key: "objective", text: "Complete the fixture objective and verify the result." } }]
          : step === 2 ? [{ type: "toolCall", id: "rollover", name: "context_rollover", arguments: { checkpoint_ready: true } }]
          : [{ type: "text", text: step === 3 ? "Checkpoint saved; continuing after rollover." : "Work verified." }];
        const stopReason = step <= 2 ? "toolUse" : step === 3 ? outcome : "stop";
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason,
          ...(stopReason === "error" ? { errorMessage: "non-retryable fixture failure" } : {}),
          usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = new AssistantMessageEventStream();
        if (stopReason === "error" || stopReason === "aborted") stream.push({ type: "error", reason: stopReason, error: message });
        else stream.push({ type: "done", reason: stopReason, message });
        stream.end();
        return stream;
      };
      await runtime.session.prompt("Original objective with historical evidence: verify rollover.");
      assert.deepEqual(errors, []);
      assert.equal(requests.length, outcome === "stop" ? 5 : 3);
      assert.equal(events.filter((event) => event === "agent_settled").length, outcome === "stop" ? 2 : 1);
      const boundaries = manager.getBranch().filter((entry) => entry.type === "compaction");
      assert.equal(boundaries.length, outcome === "stop" ? 1 : 0);
      if (outcome === "stop") {
        const firstSettlement = lifecycle.indexOf("settled-first");
        assert.deepEqual(lifecycle.slice(firstSettlement, firstSettlement + 3), ["settled-first", "settled-last", "start"]);
        assert(requests[4]!.includes("Inspect the queued follow-up"));
        assert.equal(boundaries[0]!.firstKeptEntryId, boundaries[0]!.id, "retain-none compaction owns its boundary");
        assert(!requests[3]!.includes("historical evidence"));
        assert(requests[3]!.includes("Complete the fixture objective"));
        assert(historyMatches(manager.getBranch(), "historical evidence").matches.length > 0);
        const reloaded = SessionManager.open(manager.getSessionFile()!);
        assert(!JSON.stringify(reloaded.buildSessionContext()).includes("historical evidence"));
        assert(JSON.stringify(reloaded.getBranch()).includes("historical evidence"));
      }
    } finally { runtime.session.dispose(); }
  }
  console.log("native rollover boundary, continuation, cancellation and persistence verified");
} finally { await rm(root, { recursive: true, force: true }); }
