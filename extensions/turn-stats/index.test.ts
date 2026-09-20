import { expect, test } from "bun:test";
import extension from "./index.ts";
import { decodeSummary, emptySummary, recordResponse, summaryText } from "./stats.ts";
function harness() {
  let clock = 0;
  const handlers = new Map<string, any>(); const entries: any[] = [];
  let command: any;
  extension({ on: (name: string, fn: any) => handlers.set(name, fn), appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }), registerEntryRenderer() {}, registerCommand: (_: string, value: any) => { command = value; } } as any, () => clock);
  return { entries, setTime: (time: number) => { clock = time; }, fire: (name: string, event = {}) => handlers.get(name)?.(event), command: () => command };
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
test("missing and invalid measurements remain unknown while recorded zeros remain known", () => {
  const summary = emptySummary();
  recordResponse(summary, { usage: { input: 0, output: NaN, cacheRead: -1, cost: { total: Infinity } }, stopReason: "error" });
  recordResponse(summary, { stopReason: "aborted" });
  expect(summary.outcome).toBe("error");
  expect(summaryText(summary, true)).toContain("output: unknown");
  expect(summaryText(summary, true)).toContain("input: 0 · missing for 1 responses");
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
  expect(notices[0]).toContain("output: 123");
  h.fire("agent_start"); h.setTime(2000); await h.command().handler("", ctx);
  expect(notices[1]).toContain("Turn in progress");
  expect(notices[1]).not.toContain("Turn settled");
  expect(notices[1]).toContain("2s");
});

test("timing aggregates measured response windows without tool time or missing samples", () => {
  const h = harness(); h.fire("agent_start");
  h.fire("before_provider_request");
  h.setTime(1000); h.fire("message_update", { assistantMessageEvent: { type: "toolcall_delta" } });
  h.setTime(2000);
  const firstMessage = { role: "assistant", usage: { output: 100 } };
  h.fire("message_end", { message: firstMessage });
  h.fire("message_end", { message: firstMessage });
  h.fire("tool_execution_start");
  h.setTime(10000); h.fire("tool_execution_end", { isError: false });
  h.fire("before_provider_request");
  h.setTime(13000); h.fire("message_update", { assistantMessageEvent: { type: "thinking_delta" } });
  h.setTime(14000); h.fire("message_update", { assistantMessageEvent: { type: "text_delta" } });
  h.setTime(16000); h.fire("message_end", { message: { role: "assistant", usage: { output: 60 } } });
  h.fire("message_end", { message: { role: "assistant", usage: { output: 10 } } });
  h.setTime(20000); h.fire("agent_settled");
  const summary = h.entries[0].data;
  expect(summary.timing).toEqual({ latencyMs: 4000, latencySamples: 2, streamMs: 4000, outputTokens: 160, streamSamples: 2 });
  expect(summaryText(summary, true)).toContain("Mean first-output latency: 2000ms · 2/3 responses measured");
  expect(summaryText(summary, true)).toContain("Aggregate streaming rate: 40.0 tokens/s · 2/3 responses measured");
  expect(decodeSummary(summary)).toBeDefined();
});

test("retry anchors and lifecycle reset prevent timing from leaking across requests", () => {
  const h = harness(); h.fire("agent_start"); h.fire("before_provider_request");
  h.setTime(5000); h.fire("before_provider_request");
  h.setTime(5100); h.fire("message_update", { assistantMessageEvent: { type: "text_delta" } });
  h.setTime(5200); h.fire("message_end", { message: { role: "assistant", usage: { output: 99 } } });
  h.fire("agent_settled");
  expect(h.entries[0].data.timing).toEqual({ latencyMs: 100, latencySamples: 1, streamMs: 0, outputTokens: 0, streamSamples: 0 });
  h.fire("agent_start"); h.fire("before_provider_request");
  h.fire("session_tree"); h.fire("agent_start");
  h.fire("message_update", { assistantMessageEvent: { type: "text_delta" } });
  h.setTime(6200); h.fire("message_end", { message: { role: "assistant", usage: { output: 100 } } });
  h.fire("agent_settled");
  expect(summaryText(h.entries[1].data, true)).toContain("latency: unknown · 0/1 responses measured");
});

test("legacy summaries remain readable and malformed timing is rejected", () => {
  const summary = emptySummary(); recordResponse(summary, {});
  delete summary.timing;
  expect(decodeSummary(summary)).toBeDefined();
  expect(summaryText(summary, true)).toContain("streaming rate: unknown");
  for (const timing of [null, {}, { latencyMs: 0, latencySamples: 2, streamMs: 0, outputTokens: 0, streamSamples: 0 },
    { latencyMs: NaN, latencySamples: 1, streamMs: 0, outputTokens: 0, streamSamples: 0 },
    { latencyMs: 0, latencySamples: 1, streamMs: 0, outputTokens: 12, streamSamples: 0 },
  ]) expect(decodeSummary({ ...summary, timing })).toBeUndefined();
});
