import { expect, test } from "bun:test";
import { entryUsage, sumUsage, UsageTotalsCache } from "./usage.ts";

function assistant(input: number, output: number, cost: number) {
  return { type: "message", message: { role: "assistant", usage: { input, output, cost: { total: cost } } } };
}

function toolResult(usage?: { input: number; output: number; cost: number }) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      usage: usage ? { input: usage.input, output: usage.output, cost: { total: usage.cost } } : undefined,
    },
  };
}

test("counts assistant, tool-result, summary, and compaction usage like pi's own footer", () => {
  const entries = [
    assistant(100, 10, 0.02),
    // Nested model usage reported by tools such as subagents or side-chat.
    toolResult({ input: 5, output: 1, cost: 0.001 }),
    { type: "branch_summary", usage: { input: 20, output: 2, cost: { total: 0.003 } } },
    { type: "compaction", usage: { input: 30, output: 3, cost: { total: 0.004 } } },
  ];

  expect(sumUsage(entries)).toEqual({ input: 155, output: 16, cost: 0.028 });
});

test("ignores entries without attributable usage", () => {
  const entries = [
    { type: "message", message: { role: "user" } },
    toolResult(),
    { type: "custom", customType: "plan", data: {} },
    { type: "branch_summary" },
    undefined,
    "not-an-entry",
  ];

  expect(sumUsage(entries)).toEqual({ input: 0, output: 0, cost: 0 });
  expect(entryUsage({ type: "message", message: { role: "user", usage: { input: 9 } } })).toBeUndefined();
  expect(entryUsage(assistant(1, 2, 3))).toEqual({ input: 1, output: 2, cost: { total: 3 } });
});

test("tolerates partial usage records", () => {
  const entries = [
    { type: "message", message: { role: "assistant", usage: { input: 7 } } },
    { type: "compaction", usage: { output: 5 } },
  ];

  expect(sumUsage(entries)).toEqual({ input: 7, output: 5, cost: 0 });
});

test("totals are scanned once per change, not once per frame", () => {
  const cache = new UsageTotalsCache();
  let scans = 0;
  const entries = () => {
    scans++;
    return [assistant(100, 10, 0.02)];
  };

  expect(cache.get(entries)).toEqual({ input: 100, output: 10, cost: 0.02 });
  cache.get(entries);
  cache.get(entries);
  expect(scans).toBe(1);

  cache.invalidate();
  expect(cache.get(entries)).toEqual({ input: 100, output: 10, cost: 0.02 });
  expect(scans).toBe(2);
});

test("invalidation picks up newly recorded usage", () => {
  const cache = new UsageTotalsCache();
  const entries = [assistant(100, 10, 0.02)];

  expect(cache.get(() => entries).input).toBe(100);
  entries.push(assistant(50, 5, 0.01));
  expect(cache.get(() => entries).input).toBe(100);

  cache.invalidate();
  expect(cache.get(() => entries)).toEqual({ input: 150, output: 15, cost: 0.03 });
});
