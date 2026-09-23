import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";
import stats from "./index.ts";

const root = await mkdtemp(join(tmpdir(), "pi-continuation-native-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.ANTHROPIC_API_KEY = "fixture-not-a-real-key";
let network = 0;
globalThis.fetch = (() => { network++; throw new Error("Network forbidden"); }) as unknown as typeof fetch;
let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
let clock = 0, calls = 0, boundaries = 0, starts = 0, settled = 0;
const errors: unknown[] = [];
try {
  const model = getModels("anthropic")[0]!;
  const manager = SessionManager.create(root, join(root, "sessions"));
  const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      extensionFactories: [pi => stats(pi, () => clock), pi => {
        pi.on("agent_start", () => { starts++; });
        pi.on("agent_settled", () => { settled++; });
        pi.on("agent_before_settle", () => {
          if (boundaries++ > 0) return;
          clock += 5000;
          return { continue: true, entries: [{ type: "custom_message", customType: "fixture-continuation", content: "Continue once for the native lifecycle proof.", display: false }] };
        });
        pi.registerTool({ name: "fixture_tool", label: "Fixture", description: "Local fixture", parameters: Type.Object({}),
          execute: async () => { clock += 200; return { content: [{ type: "text", text: "done" }], details: {} }; } });
      }] } });
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: manager, model }));
  await session.bindExtensions({ onError: error => errors.push(error) });
  session.setActiveToolsByName(["fixture_tool"]);
  session.agent.streamFunction = async (_model, _context, options) => {
    await options?.onPayload?.({ fixture: true }, model);
    clock += 1000;
    const tool = ++calls === 1;
    const message = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: tool ? "toolUse" as const : "stop" as const,
      content: tool ? [{ type: "toolCall" as const, id: "fixture-call", name: "fixture_tool", arguments: {} }] : [{ type: "text" as const, text: "fixture answer" }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } } };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    clock += 100;
    stream.push(tool ? { type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: message } : { type: "text_delta", contentIndex: 0, delta: "fixture answer", partial: message });
    setTimeout(() => { clock += 500; stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); }, 0);
    return stream;
  };
  await session.prompt("Run the fixture tool then answer.");
  const summaries = manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "turn-usage-summary");
  assert.equal(calls, 3);
  assert.equal(starts, 2, "the host must repeat agent_start before final settlement");
  assert.equal(settled, 1);
  assert.equal(summaries.length, 1);
  const summary = (summaries[0] as any).data;
  assert.equal(summary.responses, 3, "all responses survive the repeated agent_start");
  assert.equal(summary.tools, 1, "tool work from before continuation remains counted");
  assert.equal(clock, 10000);
  assert.equal(summary.durationMs, 10000, "duration includes initial run and continuation wait");
  assert.equal(summary.usage.output.known, 15);
  assert.equal(summary.usage.cost.known, 0.09);
  assert.equal(summary.timing.latencySamples, 3);
  assert.equal(summary.timing.streamSamples, 3);
  assert.equal(summary.timing.outputTokens, 15);
  assert.equal(summary.timing.streamMs, 1500);
  assert.equal(network, 0);
  assert.deepEqual(errors, []);
  console.log("Native pre-settle continuation preserves whole-turn accounting");
} finally {
  if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  await rm(root, { recursive: true, force: true });
}
