import { expect, test } from "bun:test";
import type { UsageTotals } from "./format.ts";
import { entryUsage, sumUsage, UsageTotalsCache } from "./usage.ts";
import { usageRecord } from "../subagents/usage.ts";

function assistant(input: number, output: number, cost: number) {
  return { type: "message", message: { role: "assistant", usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } } };
}

function toolResult(usage?: { input: number; output: number; cost: number }) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      usage: usage ? { input: usage.input, output: usage.output, cacheRead: 0, cacheWrite: 0, cost: { total: usage.cost } } : undefined,
    },
  };
}

function covered(totals: UsageTotals, responses: number, missing: UsageTotals["missing"] = {}): UsageTotals {
  return { ...totals, responses, missing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...missing } };
}

test("counts assistant, tool-result, summary, and compaction usage like pi's own footer", () => {
  const entries = [
    assistant(100, 10, 0.02),
    // Nested model usage reported by tools such as subagents or side-chat.
    toolResult({ input: 5, output: 1, cost: 0.001 }),
    { type: "branch_summary", usage: { input: 20, output: 2, cost: { total: 0.003 } } },
    { type: "compaction", usage: { input: 30, output: 3, cost: { total: 0.004 } } },
  ];

  expect(sumUsage(entries)).toEqual(covered({ input: 155, output: 16, cacheRead: 0, cacheWrite: 0, cost: 0.028 }, 4, { cacheRead: 2, cacheWrite: 2 }));
});

test("ignores entries without attributable usage", () => {
  const entries = [
    { type: "message", message: { role: "user" } },
    toolResult(),
    { type: "custom", customType: "plan", data: {} },
    { type: "branch_summary" },
    { type: "compaction", fromHook: true },
    undefined,
    "not-an-entry",
  ];

  expect(sumUsage(entries)).toEqual(covered({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, 0));
  expect(entryUsage({ type: "message", message: { role: "user", usage: { input: 9 } } })).toBeUndefined();
  expect(entryUsage(assistant(1, 2, 3))).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 3 } });
});

test("tolerates partial usage records", () => {
  const entries = [
    { type: "message", message: { role: "assistant", usage: { input: 7 } } },
    { type: "compaction", usage: { output: 5 } },
  ];

  expect(sumUsage(entries)).toEqual(covered({ input: 7, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 }, 2,
    { input: 1, output: 1, cacheRead: 2, cacheWrite: 2, cost: 2 }));
});

test("missing assistant and standalone usage records stay unknown instead of becoming zero", () => {
  const entries = [
    { type: "message", message: { role: "assistant" } },
    { type: "message", message: { role: "assistant", usage: null } },
    { type: "usage", kind: "cache_warm" },
  ];
  expect(sumUsage(entries)).toEqual(covered({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, 3,
    { input: 3, output: 3, cacheRead: 3, cacheWrite: 3, cost: 3 }));
});

test("known zero and partial records preserve per-field coverage", () => {
  const entries = [
    assistant(0, 0, 0),
    { type: "message", message: { role: "assistant", usage: { input: 100, output: 20, cacheWrite: 0, cost: { total: 0.01 } } } },
    { type: "message", message: { role: "assistant" } },
  ];
  expect(sumUsage(entries)).toEqual(covered({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01 }, 3,
    { input: 1, output: 1, cacheRead: 2, cacheWrite: 1, cost: 1 }));
});

test("cache totals include nested calls, summaries, compaction and warming without double-counting input", () => {
  const entries = [
    { type: "message", message: { role: "assistant", usage: { input: 10, cacheRead: 100, cacheWrite: 20 } } },
    { type: "message", message: { role: "toolResult", usage: { cacheRead: 30, cacheWrite: 4 } } },
    { type: "branch_summary", usage: { cacheRead: 50, cacheWrite: 6 } },
    { type: "compaction", usage: { cacheRead: 70, cacheWrite: 8 } },
    { type: "usage", kind: "cache_warm", usage: { cacheRead: 90, cacheWrite: 10 } },
    { type: "message", message: { role: "user", usage: { cacheRead: 999, cacheWrite: 999 } } },
    { type: "custom", usage: { cacheRead: 999, cacheWrite: 999 } },
  ];
  expect(sumUsage(entries)).toEqual(covered({ input: 10, output: 0, cacheRead: 340, cacheWrite: 48, cost: 0 }, 5,
    { input: 4, output: 5, cost: 5 }));
});

test("malformed numeric fields cannot corrupt cumulative usage", () => {
  const invalid = [undefined, null, NaN, Infinity, -Infinity, -1, "100", true, {}];
  const entries: unknown[] = invalid.map((value) => ({
    type: "usage", usage: { input: value, output: value, cacheRead: value, cacheWrite: value, cost: { total: value } },
  }));
  entries.push({ type: "usage", usage: { input: 12, output: 3, cacheRead: 45, cacheWrite: 6, cost: { total: 0.012 } } });
  expect(sumUsage(entries)).toEqual(covered({ input: 12, output: 3, cacheRead: 45, cacheWrite: 6, cost: 0.012 }, 10,
    { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, cost: 9 }));
});

test("totals are scanned once per change, not once per frame", () => {
  const cache = new UsageTotalsCache();
  let scans = 0;
  const entries = () => {
    scans++;
    return [assistant(100, 10, 0.02)];
  };

  expect(cache.get(entries)).toEqual(covered({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.02 }, 1));
  cache.get(entries);
  cache.get(entries);
  expect(scans).toBe(1);

  cache.invalidate();
  expect(cache.get(entries)).toEqual(covered({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.02 }, 1));
  expect(scans).toBe(2);
});

test("invalidation picks up newly recorded usage", () => {
  const cache = new UsageTotalsCache();
  const entries = [assistant(100, 10, 0.02)];

  expect(cache.get(() => entries).input).toBe(100);
  entries.push(assistant(50, 5, 0.01));
  expect(cache.get(() => entries).input).toBe(100);

  cache.invalidate();
  expect(cache.get(() => entries)).toEqual(covered({ input: 150, output: 15, cacheRead: 0, cacheWrite: 0, cost: 0.03 }, 2));
});

test("a changed branch leaf picks up idle cache-warming usage without an assistant event", () => {
  const cache = new UsageTotalsCache();
  const entries: unknown[] = [assistant(100, 10, 0.02)];
  let scans = 0;
  const read = () => { scans++; return entries; };
  expect(cache.get(read, "response").cost).toBe(0.02);
  entries.push({ type: "usage", kind: "cache_warm", usage: { input: 1, output: 1, cacheRead: 200, cacheWrite: 30, cost: { total: 0.001 } } });
  expect(cache.get(read, "response").cacheRead).toBe(0);
  expect(cache.get(read, "warm")).toEqual(covered({ input: 101, output: 11, cacheRead: 200, cacheWrite: 30, cost: 0.021 }, 2));
  cache.get(read, "warm");
  expect(scans).toBe(2);
  entries.pop();
  expect(cache.get(read, "response")).toEqual(covered({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.02 }, 1));
});

test("branch changes rebuild completeness metadata without retaining discarded missing records", () => {
  const cache = new UsageTotalsCache();
  const entries: unknown[] = [assistant(0, 0, 0)];
  const complete = covered({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, 1);
  expect(cache.get(() => entries, "complete")).toEqual(complete);
  entries.push({ type: "message", message: { role: "assistant" } });
  expect(cache.get(() => entries, "complete")).toEqual(complete);
  expect(cache.get(() => entries, "partial")).toEqual(covered({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, 2,
    { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: 1 }));
  entries.pop();
  cache.invalidate();
  expect(cache.get(() => entries, "complete")).toEqual(complete);
});

function child(id: string, usage: Record<string, unknown> = {}) {
  return { id, type: "custom", customType: "subagent-usage", data: {
    version: 1, agentId: "worker", agentName: "Review", usage,
  } };
}

test("adds persisted child deltas once and ignores repeated cumulative snapshots", () => {
  const first = child("child-response-1", { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, cost: 0.25 });
  const second = child("child-response-2", { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, cost: 0.25 });
  const entries = [
    assistant(10, 2, 0.01), first, first, JSON.parse(JSON.stringify(first)), second,
    { type: "custom", customType: "subagent-state", data: { agents: [{ usage: { input: 200, cost: 0.5 } }] } },
    { type: "custom_message", customType: "subagent-completion", details: { usage: { input: 200, cost: 0.5 } } },
    { type: "message", message: { role: "toolResult", details: { action: "read", agents: [{ usage: { input: 200, cost: 0.5 } }] } } },
  ];
  expect(sumUsage(entries)).toEqual(covered({ input: 210, output: 42, cacheRead: 60, cacheWrite: 0, cost: 0.51 }, 3));
});

test("shared parent entries deduplicate by identity without collapsing equal independent responses", () => {
  const first = { ...assistant(10, 2, 0.01), id: "parent-1" };
  const sharedWithoutId = assistant(10, 2, 0.01);
  expect(sumUsage([first, { ...first }, sharedWithoutId, sharedWithoutId, assistant(10, 2, 0.01)]))
    .toEqual(covered({ input: 30, output: 6, cacheRead: 0, cacheWrite: 0, cost: 0.03 }, 3));
});

test("partial and malformed child metrics preserve honest coverage", () => {
  expect(sumUsage([
    assistant(0, 0, 0),
    child("partial", { input: 7, output: -1, cacheRead: "9", cacheWrite: 0, cost: NaN }),
    child("missing"),
    { ...child("no-usage"), data: { version: 1, agentId: "worker", agentName: "Review" } },
    { ...child("invalid-version"), data: { version: 999, agentId: "worker", agentName: "Review", usage: { input: 999 } } },
    { ...child("invalid-identity"), data: { version: 1, usage: { input: 999 } } },
  ])).toEqual(covered({ input: 7, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, 4,
    { input: 2, output: 3, cacheRead: 3, cacheWrite: 2, cost: 3 }));
});

test("new child records preserve omitted usage after JSON persistence instead of recording false zeroes", () => {
  const record = usageRecord({ role: "assistant", usage: { input: 40, cacheRead: 0 } }, { id: "worker", name: "Review" });
  const entry = JSON.parse(JSON.stringify({ id: "partial-child", type: "custom", customType: "subagent-usage", data: record }));
  expect(sumUsage([entry])).toEqual(covered({ input: 40, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, 1,
    { output: 1, cacheWrite: 1, cost: 1 }));
});

test("reload and branch navigation use persisted child deltas without retaining later turns", () => {
  const parent = assistant(1, 2, 0.01);
  const first = child("first", { input: 100, output: 20, cacheRead: 30, cacheWrite: 4, cost: 0.1 });
  const later = child("later", { input: 200, output: 40, cacheRead: 60, cacheWrite: 8, cost: 0.2 });
  const original = sumUsage([parent, first]);
  const cache = new UsageTotalsCache();
  const saved = JSON.parse(JSON.stringify([parent, first]));
  expect(cache.get(() => saved, "first")).toEqual(original);
  saved.push(later);
  const complete = cache.get(() => saved, "later");
  expect(complete.input).toBe(301);
  expect(complete.cost).toBeCloseTo(0.31);
  expect(complete.responses).toBe(3);
  expect(cache.get(() => saved.slice(0, 2), "first")).toEqual(original);
  expect(new UsageTotalsCache().get(() => JSON.parse(JSON.stringify(saved)), "later")).toEqual(complete);
});
