import { expect, test } from "bun:test";
import { decodeUsageRecord, usageRecord } from "./usage.ts";

const agent = { id: "a", name: "audit" };

test("records each child response's usage without its cumulative agent snapshot", () => {
  const record = usageRecord({
    role: "assistant",
    provider: "provider",
    model: "model",
    usage: {
      input: 1_200,
      output: 350,
      cacheRead: 2_000,
      cacheWrite: 100,
      cost: { total: 0.1234 },
    },
  }, { ...agent, usage: { input: 999_999 } } as typeof agent);
  expect(record).toEqual({
    version: 1, agentId: "a", agentName: "audit", provider: "provider", model: "model",
    usage: { input: 1_200, output: 350, cacheRead: 2_000, cacheWrite: 100, cost: 0.1234 },
  });
  expect(decodeUsageRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
});

test("missing or invalid child metrics remain unknown across persistence", () => {
  const record = usageRecord({
    role: "assistant",
    usage: { input: 0, output: -1, cacheRead: Infinity, cacheWrite: "20", cost: { total: NaN } },
  }, agent)!;
  const restored = decodeUsageRecord(JSON.parse(JSON.stringify(record)))!;
  expect(restored.usage.input).toBe(0);
  for (const field of ["output", "cacheRead", "cacheWrite", "cost"] as const) {
    expect(restored.usage[field]).toBeUndefined();
  }
  const missing = usageRecord({ role: "assistant" }, agent)!;
  expect(JSON.parse(JSON.stringify(missing)).usage).toEqual({});
  expect(decodeUsageRecord(missing)?.usage.cost).toBeUndefined();
});

test("only assistant responses become child usage records", () => {
  for (const message of [null, "text", {}, { role: "user", usage: { input: 99 } }, { role: "toolResult", usage: { input: 99 } }]) {
    expect(usageRecord(message, agent)).toBeUndefined();
  }
});

test("validates persisted envelopes while retaining legacy numeric cost and measured zero", () => {
  const record = { version: 1, agentId: "one", agentName: "first", usage: { input: 10, output: 0, cost: 0 } };
  expect(decodeUsageRecord(record)?.usage).toEqual({ input: 10, output: 0, cacheRead: undefined, cacheWrite: undefined, cost: 0 });
  for (const invalid of [null, {}, { ...record, version: 2 }, { ...record, agentId: 1 }, { ...record, agentName: null }]) {
    expect(decodeUsageRecord(invalid)).toBeUndefined();
  }
});
