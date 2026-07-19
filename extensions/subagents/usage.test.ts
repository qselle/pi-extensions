import { expect, test } from "bun:test";
import {
  SUBAGENT_USAGE_ENTRY_TYPE,
  addSubagentUsage,
  emptySubagentUsage,
  formatSubagentUsage,
  restoreSubagentUsage,
  usageRecord,
} from "./usage.ts";

test("normalizes, aggregates, and formats child usage", () => {
  const record = usageRecord({
    provider: "provider",
    model: "model",
    usage: {
      input: 1_200,
      output: 350,
      cacheRead: 2_000,
      cacheWrite: 100,
      cost: { total: 0.1234 },
    },
  }, { id: "a", name: "audit" });
  expect(record).toMatchObject({ agentId: "a", agentName: "audit", provider: "provider", model: "model" });
  const total = addSubagentUsage(emptySubagentUsage(), record!.usage);
  expect(formatSubagentUsage(total)).toBe("agents ↑1.2k ↓350 R2.0k W100 $0.1234");
});

test("restores only valid usage entries on the active branch", () => {
  const entries = [
    {
      type: "custom",
      customType: SUBAGENT_USAGE_ENTRY_TYPE,
      data: {
        version: 1,
        agentId: "one",
        agentName: "first",
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
      },
    },
    { type: "custom", customType: SUBAGENT_USAGE_ENTRY_TYPE, data: { version: 2, usage: { input: 999 } } },
    {
      type: "custom",
      customType: SUBAGENT_USAGE_ENTRY_TYPE,
      data: {
        version: 1,
        agentId: "two",
        agentName: "second",
        usage: { input: 5, output: 3, cacheRead: 4, cacheWrite: 1, cost: 0.02 },
      },
    },
  ];
  expect(restoreSubagentUsage(entries)).toEqual({
    input: 15,
    output: 5,
    cacheRead: 4,
    cacheWrite: 1,
    cost: 0.03,
  });
});

test("hides an empty footer aggregate", () => {
  expect(formatSubagentUsage(emptySubagentUsage())).toBeUndefined();
});
