import { expect, test } from "bun:test";
import { buildReport, formatReport } from "./report.ts";
const usage = { input: 20, output: 10, cacheRead: 5, cacheWrite: 3, totalTokens: 38, cost: { total: 0.01 } };
const assistant = { type: "message", id: "a", timestamp: "2026-09-19T00:00:00Z", message: { role: "assistant", provider: "example", model: "model", stopReason: "stop", usage, content: [{ type: "text", text: "private response" }] } };
test("allowlists usage and metadata while retaining nested and summary costs", () => {
  const report = buildReport([
    assistant, assistant,
    { type: "message", id: "b", message: { role: "toolResult", usage, content: "secret tool output" } },
    { type: "compaction", id: "c", usage, summary: "private summary" },
    { type: "branch_summary", id: "d", usage },
    { type: "message", message: { role: "user", content: "private prompt", usage } },
    { type: "custom", data: { secret: "private key", usage } },
  ], "session", new Date(0));
  expect(report.rows).toHaveLength(4);
  expect(report.totals.input).toEqual({ known: 80, missing: 0 });
  expect(report.totals.cacheRead.known).toBe(20);
  expect(report.totals.cost.known).toBe(0.04);
  expect(report.generatedAt).toBe("1970-01-01T00:00:00.000Z");
  const json = formatReport(report, "json");
  for (const secret of ["private", "secret", "content", '"summary":']) expect(json).not.toContain(secret);
  expect(report.rows[1]!.model).toBeNull();
});
test("missing and malformed usage stay unknown and zero remains a valid value", () => {
  const report = buildReport([
    { type: "message", message: { role: "assistant" } },
    { type: "message", message: { role: "assistant", usage: { input: -1, output: Infinity, cacheRead: 0, cacheWrite: "9", cost: { total: NaN } } } },
  ], "branch");
  expect(report.totals.input).toEqual({ known: 0, missing: 2 });
  expect(report.totals.cacheRead).toEqual({ known: 0, missing: 1 });
  expect(report.rows[1]!.totalTokens).toBeNull();
  expect(report.rows[1]!.output).toBeNull();
});
test("CSV escapes fields and neutralizes spreadsheet formulas without changing JSON metadata", () => {
  const report = buildReport([{ ...assistant, message: { ...assistant.message, model: ' =HYPERLINK("https://example.com")', provider: "one,two\nthree" } }], "branch");
  const csv = formatReport(report, "csv");
  expect(csv).toContain('"\' =HYPERLINK(""https://example.com"")"');
  expect(csv).toContain('"one,twothree"');
  expect(csv.split("\n")).toHaveLength(3);
  expect(report.rows[0]!.model).toStartWith(" =");
});

test("includes recorded child-agent usage without exporting child task or identity data", () => {
  const child = { type: "custom", customType: "subagent-usage", id: "usage-1", data: {
    version: 1, agentId: "private-agent-id", agentName: "private-task-name", provider: "example", model: "child-model",
    usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 5, cost: 0.25 }, task: "private task",
  } };
  const report = buildReport([assistant, child, child, { ...child, id: "invalid", data: { ...child.data, version: 999 } }], "branch");
  expect(report.rows).toHaveLength(2);
  expect(report.rows[1]).toMatchObject({ source: "subagent", provider: "example", model: "child-model", input: 100, output: 20, cost: 0.25, totalTokens: null });
  expect(report.totals.cost.known).toBe(0.26);
  expect(report.totals.cacheRead.known).toBe(45);
  expect(formatReport(report, "json")).not.toContain("private");
});
