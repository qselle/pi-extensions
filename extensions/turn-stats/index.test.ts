import { expect, test } from "bun:test";
import extension from "./index.ts";
import { decodeSummary, emptySummary, recordResponse, summaryText } from "./stats.ts";
function harness() {
  let clock = 0;
  let wallClock = Date.UTC(2026, 8, 23, 12, 32);
  const handlers = new Map<string, any>(); const entries: any[] = [];
  let command: any;
  extension({ on: (name: string, fn: any) => handlers.set(name, fn), appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }), registerEntryRenderer() {}, registerCommand: (_: string, value: any) => { command = value; } } as any, () => clock, () => wallClock);
  return { entries, setTime: (time: number) => { clock = time; }, setWallTime: (time: number) => { wallClock = time; }, fire: (name: string, event = {}) => handlers.get(name)?.(event), command: () => command };
}
test("full runs accumulate multiple responses and tool rounds exactly once", () => {
  const h = harness(); h.fire("agent_start");
  const message = { role: "assistant", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } };
  h.fire("message_end", { message }); h.fire("message_end", { message });
  h.fire("tool_execution_start"); h.fire("tool_execution_end", { isError: true });
  h.fire("message_end", { message: { role: "assistant", stopReason: "aborted", usage: { output: 5 } } });
  h.setTime(1234); h.fire("agent_settled"); h.fire("agent_settled");
  expect(h.entries).toHaveLength(1);
  expect(h.entries[0].data).toMatchObject({ durationMs: 1234, responses: 2, tools: 1, failedTools: 1, outcome: "interrupted", usage: { output: { known: 25, missing: 0 }, input: { known: 100, missing: 1 } } });
  expect(decodeSummary(h.entries[0].data)).toBeDefined();
  h.fire("agent_start"); h.fire("message_end", { message: { role: "assistant" } }); h.fire("agent_settled");
  expect(h.entries[1].data.responses).toBe(1);
  expect(h.entries[0].data.responses).toBe(2);
});
test("completion clock is persisted independently of monotonic run duration", () => {
  const h = harness();
  h.fire("agent_start"); h.fire("message_end", { message: { role: "assistant", usage: { output: 1 } } });
  h.setTime(2000); h.setWallTime(1_000_000); h.fire("agent_settled");
  expect(h.entries[0].data).toMatchObject({ durationMs: 2000, endedAt: 1_000_000 });
});
test("repeated agent starts before settlement preserve elapsed time, usage, tool counts, timing and deduplication", () => {
  const h = harness(); h.setTime(100); h.fire("agent_start"); h.fire("before_provider_request");
  h.setTime(200); h.fire("message_update", { assistantMessageEvent: { type: "toolcall_delta", delta: "{}" } });
  const first = { role: "assistant", usage: { input: 10, output: 100, cacheRead: 90, cacheWrite: 0, cost: { total: 0.01 } } };
  h.setTime(1200); h.fire("message_end", { message: first });
  h.fire("tool_execution_start"); h.fire("tool_execution_end", { isError: true });
  h.setTime(5000); h.fire("before_provider_request");
  h.setTime(5050); h.fire("agent_start");
  h.setTime(5100); h.fire("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "thinking" } });
  h.setTime(5600); h.fire("message_end", { message: first }); // delayed duplicate from before continuation
  h.setTime(6100); h.fire("message_end", { message: { role: "assistant", usage: { input: 20, output: 50, cacheRead: 80, cacheWrite: 0, cost: { total: 0.02 } } } });
  h.setTime(8100); h.fire("agent_settled");
  expect(h.entries).toHaveLength(1);
  expect(h.entries[0].data).toMatchObject({ durationMs: 8000, responses: 2, tools: 1, failedTools: 1,
    usage: { input: { known: 30, missing: 0 }, output: { known: 150, missing: 0 }, cacheRead: { known: 170, missing: 0 }, cost: { known: 0.03, missing: 0 } },
    timing: { latencyMs: 200, latencySamples: 2, streamMs: 2000, outputTokens: 150, streamSamples: 2 } });
  h.setTime(8200); h.fire("agent_start"); h.fire("message_end", { message: first });
  h.setTime(8700); h.fire("agent_settled");
  expect(h.entries[1].data).toMatchObject({ durationMs: 500, responses: 1, tools: 0, failedTools: 0, usage: { output: { known: 100, missing: 0 } } });
});
test("missing and invalid measurements remain unknown while recorded zeros remain known", () => {
  const summary = emptySummary();
  recordResponse(summary, { usage: { input: 0, output: NaN, cacheRead: -1, cost: { total: Infinity } }, stopReason: "error" });
  recordResponse(summary, { stopReason: "aborted" });
  expect(summary.outcome).toBe("error");
  expect(summaryText(summary, true)).toContain("out: unknown");
  expect(summaryText(summary, true)).toContain("in: 0 · missing for 1 reply");
  expect(decodeSummary({ ...summary, durationMs: -1 })).toBeUndefined();
  expect(decodeSummary({ ...summary, usage: {} })).toBeUndefined();
});
for (const boundary of ["session_start", "session_tree", "session_shutdown"]) test(`${boundary} discards an unfinished run`, () => {
  const h = harness(); h.fire("agent_start"); h.fire("tool_execution_start"); h.fire(boundary); h.fire("agent_settled");
  expect(h.entries).toHaveLength(0);
});
test("command restores only valid summaries from the current branch", async () => {
  const h = harness(); const notices: string[] = [];
  const summary = emptySummary(); recordResponse(summary, { usage: { output: 123 } });
  const ctx = { sessionManager: { getBranch: () => [{ type: "custom", customType: "turn-usage-summary", data: summary }, { type: "custom", customType: "turn-usage-summary", data: { version: 999 } }] }, ui: { notify: (value: string) => notices.push(value) } };
  await h.command().handler("", ctx);
  expect(notices[0]).toContain("out: 123");
  h.fire("agent_start"); h.setTime(2000); await h.command().handler("", ctx);
  expect(notices[1]).toContain("Turn in progress");
  expect(notices[1]).not.toContain("Turn settled");
  expect(notices[1]).toContain("2s");
});

test("timing aggregates measured response windows without tool time or missing samples", () => {
  const h = harness(); h.fire("agent_start");
  h.fire("before_provider_request");
  h.setTime(1000); h.fire("message_update", { assistantMessageEvent: { type: "toolcall_delta", delta: "x" } });
  h.setTime(2000);
  const firstMessage = { role: "assistant", usage: { output: 100 } };
  h.fire("message_end", { message: firstMessage });
  h.fire("message_end", { message: firstMessage });
  h.fire("tool_execution_start");
  h.setTime(10000); h.fire("tool_execution_end", { isError: false });
  h.fire("before_provider_request");
  h.setTime(13000); h.fire("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "x" } });
  h.setTime(14000); h.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "x" } });
  h.setTime(16000); h.fire("message_end", { message: { role: "assistant", usage: { output: 60 } } });
  h.fire("message_end", { message: { role: "assistant", usage: { output: 10 } } });
  h.setTime(20000); h.fire("agent_settled");
  const summary = h.entries[0].data;
  expect(summary.timing).toEqual({ latencyMs: 4000, latencySamples: 2, streamMs: 4000, outputTokens: 160, streamSamples: 2 });
  expect(summaryText(summary, true)).toContain("Average first token: 2000ms · 2/3 replies measured");
  expect(summaryText(summary, true)).toContain("Streaming rate: 40.0 tokens/s · 2/3 replies measured");
  expect(decodeSummary(summary)).toBeDefined();
});

test("retry anchors and lifecycle reset prevent timing from leaking across requests", () => {
  const h = harness(); h.fire("agent_start"); h.fire("before_provider_request");
  h.setTime(5000); h.fire("before_provider_request");
  h.setTime(5100); h.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "x" } });
  h.setTime(5200); h.fire("message_end", { message: { role: "assistant", usage: { output: 99 } } });
  h.fire("agent_settled");
  expect(h.entries[0].data.timing).toEqual({ latencyMs: 100, latencySamples: 1, streamMs: 0, outputTokens: 0, streamSamples: 0 });
  h.fire("agent_start"); h.fire("before_provider_request");
  h.fire("session_tree"); h.fire("agent_start");
  h.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "x" } });
  h.setTime(6200); h.fire("message_end", { message: { role: "assistant", usage: { output: 100 } } });
  h.fire("agent_settled");
  expect(summaryText(h.entries[1].data, true)).toContain("first token: unknown · 0/1 replies measured");
});

test("empty stream chunks are not first output and a retry replaces the request anchor", () => {
  const h = harness(); h.fire("agent_start"); h.fire("before_provider_request");
  h.setTime(100); h.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "" } });
  h.setTime(500); h.fire("before_provider_request");
  h.setTime(600); h.fire("message_update", { assistantMessageEvent: { type: "toolcall_start" } });
  h.setTime(1000); h.fire("message_update", { assistantMessageEvent: { type: "toolcall_delta", delta: "{}" } });
  h.setTime(2000); h.fire("message_end", { message: { role: "assistant", usage: { output: 100 } } });
  h.fire("agent_settled");
  expect(h.entries[0].data.timing).toEqual({ latencyMs: 500, latencySamples: 1, streamMs: 1000, outputTokens: 100, streamSamples: 1 });
});

test("legacy summaries remain readable and malformed timing is rejected", () => {
  const summary = emptySummary(); recordResponse(summary, {});
  delete summary.timing;
  expect(decodeSummary(summary)).toBeDefined();
  expect(summaryText(summary, true)).toContain("Streaming rate: unknown");
  for (const timing of [null, {}, { latencyMs: 0, latencySamples: 2, streamMs: 0, outputTokens: 0, streamSamples: 0 },
    { latencyMs: NaN, latencySamples: 1, streamMs: 0, outputTokens: 0, streamSamples: 0 },
    { latencyMs: 0, latencySamples: 1, streamMs: 0, outputTokens: 12, streamSamples: 0 },
  ]) expect(decodeSummary({ ...summary, timing })).toBeUndefined();
});
