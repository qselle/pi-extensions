import { expect, test } from "bun:test";
import { entryUsage, sumUsage } from "./usage.ts";

const parent = {
  id: "parent-1",
  type: "message",
  message: { role: "assistant", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
};

function legacyChild(id: string) {
  return { id, type: "custom", customType: "subagent-usage", data: {
    version: 1, provider: "anthropic", model: "claude",
    usage: { input: 1_000, output: 200, cacheRead: 30_000, cacheWrite: 400, cacheWrite1h: 0, cost: 0.5 },
  } };
}

test("footer totals include legacy child usage rows without agent identity exactly once", () => {
  const first = legacyChild("legacy-1");
  expect(entryUsage(first)).toEqual({ input: 1_000, output: 200, cacheRead: 30_000, cacheWrite: 400, cost: { total: 0.5 } });
  const totals = sumUsage([parent, first, first, JSON.parse(JSON.stringify(first)), legacyChild("legacy-2")]);
  expect(totals).toMatchObject({ input: 2_010, output: 402, cacheRead: 60_000, cacheWrite: 800, responses: 3 });
  expect(totals.cost).toBeCloseTo(1.01, 10);
});

test("rows with neither agent identity nor provider and model stay ignored", () => {
  const anonymous = { id: "anonymous", type: "custom", customType: "subagent-usage", data: { version: 1, usage: { input: 999 } } };
  expect(entryUsage(anonymous)).toBeUndefined();
  expect(sumUsage([parent, anonymous])).toMatchObject({ input: 10, responses: 1 });
});
