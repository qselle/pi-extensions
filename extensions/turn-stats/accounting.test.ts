import { expect, test } from "bun:test";
import extension from "./index.ts";
import { decodeLegacySummary, decodeSummary } from "./stats.ts";
import { sumUsage } from "../footer/usage.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;

function harness() {
  const handlers = new Map<string, any>();
  const renderers = new Map<string, any>();
  const entries: any[] = [];
  const notifications: string[] = [];
  let command: any;
  extension({
    on: (name: string, fn: any) => handlers.set(name, fn),
    events: { emit() {} },
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    registerEntryRenderer: (customType: string, renderer: any) => renderers.set(customType, renderer),
    registerCommand: (_: string, value: any) => { command = value; },
  } as any, () => 0, () => 0);
  const ctx = { sessionManager: { getSessionId: () => "a", getBranch: () => entries }, ui: { notify: (text: string) => notifications.push(text) } };
  return {
    entries, renderers, notifications,
    fire: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
    command: (args: string) => command.handler(args, ctx),
  };
}

const usage = (input: number, output: number, cost: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } });

test("tool-result and compaction usage join the run totals and match the footer delta", () => {
  const h = harness();
  const assistant = { role: "assistant", usage: usage(100, 20, 0.1) };
  const toolResult = { role: "toolResult", usage: usage(40, 8, 0.05) };
  const plainToolResult = { role: "toolResult" };
  const compactionEntry = { type: "compaction", usage: usage(5000, 600, 0.68) };
  h.fire("agent_start");
  h.fire("message_end", { message: assistant });
  h.fire("tool_execution_start"); h.fire("tool_execution_end", {});
  h.fire("message_end", { message: toolResult });
  h.fire("message_end", { message: toolResult });
  h.fire("message_end", { message: plainToolResult });
  h.fire("session_compact", { compactionEntry, reason: "threshold", willRetry: false });
  h.fire("agent_settled");

  const summary = decodeSummary(h.entries[0].data)!;
  expect(summary).toMatchObject({ responses: 1, tools: 1, extraUsage: 2 });
  const footer = sumUsage([
    { type: "message", message: assistant },
    { type: "message", message: toolResult },
    { type: "message", message: plainToolResult },
    compactionEntry,
  ]);
  expect(summary.usage.input.known).toBe(footer.input);
  expect(summary.usage.output.known).toBe(footer.output);
  expect(summary.usage.cost.known).toBeCloseTo(footer.cost, 10);
  expect(summary.usage.cost.known).toBeCloseTo(0.83, 10);
  expect(summary.usage.cost.missing).toBe(0);

  const row = h.renderers.get("turn-usage-summary")({ type: "custom", customType: "turn-usage-summary", data: summary }, { expanded: false }, theme).render(160);
  expect(row.join("\n")).toContain("$0.83");
});

test("compaction outside a run is not attributed to a turn", () => {
  const h = harness();
  h.fire("session_compact", { compactionEntry: { usage: usage(1, 1, 1) } });
  h.fire("agent_start");
  h.fire("message_end", { message: { role: "assistant", usage: usage(1, 1, 0.01) } });
  h.fire("agent_settled");
  expect(h.entries[0].data.usage.cost.known).toBe(0.01);
  expect(h.entries[0].data.extraUsage).toBeUndefined();
});

test("usage missing from every record stays unknown even with extra records", () => {
  const h = harness();
  h.fire("agent_start");
  h.fire("message_end", { message: { role: "assistant", usage: { input: 1, output: 1 } } });
  h.fire("message_end", { message: { role: "toolResult", usage: { input: 2, output: 2 } } });
  h.fire("agent_settled");
  const summary = decodeSummary(h.entries[0].data)!;
  expect(summary.usage.cost).toEqual({ known: 0, missing: 2 });
  const row = h.renderers.get("turn-usage-summary")({ data: summary, type: "custom", customType: "turn-usage-summary" }, { expanded: false }, theme).render(160);
  expect(row.join("\n")).toContain("$?");
});

const legacy = {
  startedAt: 1_789_670_609_224, endedAt: 1_789_670_632_835, elapsedMs: 23_611,
  averageTiming: { responseCount: 6, averageTtftMs: 3974, tokensPerSecond: 100.3 },
  usage: { input: 6, output: 382, cacheRead: 7577, cacheWrite: 7901, cost: 0.1254995 },
  cacheHitPercent: 48.9,
};

test("older turn-stats entries render as one compact row", () => {
  const h = harness();
  const renderer = h.renderers.get("turn-stats");
  expect(renderer).toBeDefined();
  const lines = renderer({ type: "custom", customType: "turn-stats", data: legacy }, { expanded: false }, theme).render(160);
  expect(lines).toHaveLength(1);
  const row = lines[0]!;
  expect(row).toContain("Turn 24s");
  expect(row).toContain("out 382");
  expect(row).toContain("$0.13");
  expect(row).toContain("6 responses");
  expect(row).toContain("ttft avg");
  expect(row).not.toContain("≥");

  const summary = decodeLegacySummary(legacy)!;
  expect(summary.timing!.outputTokens / (summary.timing!.streamMs / 1000)).toBeCloseTo(100.3, 6);
  expect(summary.timing!.latencyMs / summary.timing!.latencySamples).toBe(3974);

  // Entries without timing averages still render; malformed entries render nothing.
  const untimed = { ...legacy, averageTiming: { responseCount: 1 } };
  expect(renderer({ type: "custom", customType: "turn-stats", data: untimed }, { expanded: false }, theme).render(160)).toHaveLength(1);
  for (const data of [undefined, {}, { ...legacy, elapsedMs: -1 }, { ...legacy, averageTiming: { responseCount: 1.5 } }, { ...legacy, usage: null }]) {
    expect(renderer({ type: "custom", customType: "turn-stats", data }, { expanded: false }, theme).render(160)).toEqual([]);
  }
});

test("/turn-stats falls back to the latest older entry on the branch", async () => {
  const h = harness();
  h.entries.push({ type: "custom", customType: "turn-stats", data: legacy });
  await h.command("");
  expect(h.notifications.at(-1)).toContain("6 model responses");
});
