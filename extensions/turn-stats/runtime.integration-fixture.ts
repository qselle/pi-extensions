import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import extension from "./index.ts";
import separator from "../turn-separator/index.ts";
const root = await mkdtemp(join(tmpdir(), "pi-turn-stats-runtime-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.ANTHROPIC_API_KEY = "fixture-not-a-real-key";
let network = 0;
const extensionErrors: unknown[] = [];
globalThis.fetch = (() => { network++; throw new Error("Network forbidden"); }) as unknown as typeof fetch;
let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
try {
  const model = getModels("anthropic")[0]!;
  const manager = SessionManager.create(root, join(root, "sessions"));
  const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      extensionFactories: [extension, separator, (pi) => { pi.registerTool({ name: "fixture_tool", label: "Fixture", description: "Local fixture", parameters: Type.Object({}), execute: async () => { await Bun.sleep(100); return { content: [{ type: "text", text: "done" }], details: {} }; } }); }] } });
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: manager, model }));
  await session.bindExtensions({ onError: error => extensionErrors.push(error) });
  session.setActiveToolsByName(["fixture_tool"]);
  let calls = 0;
  session.agent.streamFunction = async (_model, _context, options) => {
    // Match the provider adapter contract so Pi emits its real request hook.
    await options?.onPayload?.({ fixture: true }, model);
    await Bun.sleep(20);
    calls++;
    const tool = calls === 1;
    const message = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: tool ? "toolUse" as const : "stop" as const,
      content: tool ? [{ type: "toolCall" as const, id: "fixture-call", name: "fixture_tool", arguments: {} }] : [{ type: "text" as const, text: "fixture answer" }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } } };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push(tool
      ? { type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: message }
      : { type: "text_delta", contentIndex: 0, delta: "fixture answer", partial: message });
    setTimeout(() => {
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    }, 300);
    return stream;
  };
  await session.prompt("Run the local fixture tool then answer.");
  const entries = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "turn-usage-summary");
  assert.equal(entries.length, 1);
  const summary = entries[0]!;
  assert.equal((summary as any).data.responses, 2);
  assert.equal((summary as any).data.tools, 1);
  assert.equal((summary as any).data.usage.output.known, 10);
  const data = (summary as any).data;
  assert(Number.isFinite(data.endedAt), "completion clock must persist with the entry");
  assert.equal(data.timing.latencySamples, 2);
  assert.equal(data.timing.streamSamples, 2);
  assert.equal(data.timing.outputTokens, 10);
  assert(data.timing.streamMs >= 500, "both real streaming windows must be measured");
  assert(data.durationMs - data.timing.streamMs >= 80, "tool work must stay outside streaming time");
  const persisted = await readFile(manager.getSessionFile()!, "utf8");
  assert(persisted.includes('"turn-usage-summary"'));
  const reopened = SessionManager.open(manager.getSessionFile()!);
  assert(reopened.getBranch().some((entry) => entry.type === "custom" && entry.customType === "turn-usage-summary"));
  assert.deepEqual((reopened.getBranch().find((entry) => entry.type === "custom" && entry.customType === "turn-usage-summary") as any).data.timing, data.timing);
  assert(!JSON.stringify(manager.buildSessionContext().messages).includes('"turn-usage-summary"'));
  await session.reload();
  await session.prompt("/turn-stats");
  assert.equal(calls, 2, "summary command after reload must not invoke the model");
  assert.equal(manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "turn-usage-summary").length, 1);
  const renderer = session.extensionRunner.getEntryRenderer("turn-usage-summary")!;
  for (const expanded of [false, true]) {
    const component = renderer(summary as any, { expanded } as any, { fg: (_: string, text: string) => text } as any);
    assert(component);
    const compact = component.render(120).join("\n");
    assert(compact.includes("first token ") && compact.includes("tokens/s"));
    assert(compact.includes("$0.06"), "turn cost is visible without expansion");
    assert(compact.includes("2 replies") && compact.includes("1 tool"), "work counts are readable without expansion");
    assert(compact.includes("in 20 · out 10") && compact.includes("cache hit 0%"), "input/output and a known uncached prompt are visible");
    if (!expanded) assert(!compact.includes("cache write 0"), "irrelevant zero cache writes are omitted");
    if (!expanded) assert.equal(component.render(120).length, 1, "default receipt is exactly one row");
    if (expanded) assert(component.render(120).join("\n").includes("2/2 replies measured"));
    for (const width of [0, 1, 12, 80]) assert(component.render(width).every((line: string) => visibleWidth(line) <= width));
  }
  await session.prompt("/turn-stats hide");
  assert.deepEqual(renderer(summary as any, { expanded: false } as any, { fg: (_: string, text: string) => text } as any)!.render(120), []);
  const work = manager.getBranch().find(entry => entry.type === "custom" && entry.customType === "worked-for-separator")!;
  const renderWork = () => session!.extensionRunner.getEntryRenderer("worked-for-separator")!(work as any, { expanded: false } as any, { fg: (_: string, text: string) => text } as any)!.render(120);
  assert.deepEqual(renderWork(), []);
  await session.reload();
  const restoredRenderer = session.extensionRunner.getEntryRenderer("turn-usage-summary")!;
  assert.deepEqual(restoredRenderer(summary as any, { expanded: false } as any, { fg: (_: string, text: string) => text } as any)!.render(120), []);
  assert.deepEqual(renderWork(), []);
  await session.prompt("/turn-stats compact");
  assert(restoredRenderer(summary as any, { expanded: false } as any, { fg: (_: string, text: string) => text } as any)!.render(120).length > 0);
  assert(renderWork().join("\n").includes("$"), "compact Worked for rules include usage");
  await session.prompt("/turn-stats full");
  assert(renderWork().join("\n").includes("$"));
  assert.equal(calls, 2);
  assert.deepEqual(extensionErrors, []);
  assert.equal(network, 0);
  console.log("native multi-round summary persistence and rendering verified");
} finally {
  if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  await rm(root, { recursive: true, force: true });
}
