import { expect, test } from "bun:test";
import { analyzeContext, type AnalyzeInput, type Estimators } from "./analysis.ts";

/** Deterministic stand-ins for pi's estimators. */
const estimate: Estimators = {
  text: (value: string) => Math.ceil(value.length / 4),
  // Fixtures carry their own token count so grouping is easy to assert.
  entry: (entry: unknown) => (entry as { tokens?: number })?.tokens ?? 0,
};

function message(role: string, tokens: number, extra: Record<string, unknown> = {}) {
  return { type: "message", tokens, message: { role, ...extra } };
}

function analyze(input: AnalyzeInput) {
  return analyzeContext(input, estimate);
}

test("splits the system prompt into named parts and attributes the remainder to pi", () => {
  const report = analyze({
    // 400 chars => 100 tokens measured for the whole prompt.
    systemPrompt: "x".repeat(400),
    contextFiles: [{ path: "AGENTS.md", content: "y".repeat(80) }],
    promptGuidelines: ["a".repeat(40), "b".repeat(40)],
    toolSnippets: { one: "c".repeat(20) },
  });

  expect(report.system.total).toBe(100);
  const byId = new Map(report.system.buckets.map((bucket) => [bucket.id, bucket]));
  expect(byId.get("file:AGENTS.md")?.tokens).toBe(20);
  expect(byId.get("guidelines")?.tokens).toBe(21);
  expect(byId.get("guidelines")?.detail).toBe("2 bullets");
  expect(byId.get("snippets")?.tokens).toBe(5);
  // 100 - (20 + 21 + 5) = 54 unattributed, i.e. pi's own prompt.
  expect(byId.get("base")?.tokens).toBe(54);
  expect(report.system.buckets.map((bucket) => bucket.tokens)).toEqual([54, 21, 20, 5]);
});

test("never reports a negative base prompt when parts exceed the measured prompt", () => {
  const report = analyze({
    systemPrompt: "x".repeat(8),
    contextFiles: [{ path: "big.md", content: "y".repeat(400) }],
  });

  expect(report.system.total).toBe(2);
  expect(report.system.buckets.find((bucket) => bucket.id === "base")).toBeUndefined();
});

test("measures tool schemas separately, largest first", () => {
  const report = analyze({
    tools: [
      { name: "small", description: "d", parameters: { type: "object" } },
      { name: "subagents", description: "x".repeat(200), parameters: { type: "object", properties: { a: { type: "string" } } } },
      { name: "empty" },
    ],
  });

  expect(report.tools.buckets[0]?.label).toBe("subagents");
  expect(report.tools.total).toBe(report.tools.buckets.reduce((sum, bucket) => sum + bucket.tokens, 0));
  // A bare name still costs something, so nothing is silently dropped.
  expect(report.tools.buckets.some((bucket) => bucket.label === "empty")).toBe(true);
});

test("groups conversation entries and itemizes each extension's own injections", () => {
  const report = analyze({
    entries: [
      message("user", 100),
      message("user", 50),
      message("assistant", 300),
      message("toolResult", 900, { toolName: "bash" }),
      message("custom", 80, { customType: "goal-context" }),
      message("custom", 40, { customType: "plan-context" }),
      message("custom", 30, { customType: "goal-context" }),
      { type: "compaction", tokens: 1200 },
      { type: "branch_summary", tokens: 200 },
    ],
  });

  const byId = new Map(report.conversation.buckets.map((bucket) => [bucket.id, bucket]));
  expect(byId.get("user")).toMatchObject({ tokens: 150, detail: "2 entries" });
  expect(byId.get("tool-results")?.tokens).toBe(900);
  expect(byId.get("compaction")?.tokens).toBe(1200);
  expect(byId.get("branch-summary")?.tokens).toBe(200);
  // The point of the extension: per-customType, not one "custom" bucket.
  expect(byId.get("custom:goal-context")).toMatchObject({ tokens: 110, detail: "2 entries" });
  expect(byId.get("custom:plan-context")?.tokens).toBe(40);
  expect(report.conversation.total).toBe(2900);
  expect(report.conversation.buckets[0]?.id).toBe("compaction");
});

test("reports the heaviest individual entries", () => {
  const report = analyze({
    entries: [
      message("toolResult", 900, { toolName: "bash" }),
      message("assistant", 300),
      message("user", 100),
      message("user", 10),
    ],
    largestCount: 2,
  });

  expect(report.largest.map((bucket) => bucket.tokens)).toEqual([900, 300]);
  expect(report.largest[0]).toMatchObject({ label: "tool results", detail: "bash" });
});

test("totals the three regions and derives the compaction point", () => {
  const report = analyze({
    systemPrompt: "x".repeat(40),
    tools: [{ name: "t", description: "y".repeat(36) }],
    entries: [message("user", 500)],
    window: 200_000,
    reserveTokens: 20_000,
    reportedTokens: 1234,
  });

  expect(report.estimated).toBe(report.system.total + report.tools.total + report.conversation.total);
  expect(report.window).toBe(200_000);
  expect(report.compactAt).toBe(180_000);
  expect(report.reported).toBe(1234);
});

test("degrades gracefully on unknown windows, junk entries, and unserializable schemas", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  const report = analyze({
    entries: [null, "nope", 7, { type: "custom", customType: "file-changes" }, { type: "message" }],
    tools: [{ name: "circular", parameters: circular }],
    window: Number.NaN,
  });

  expect(report.window).toBe(0);
  expect(report.compactAt).toBeUndefined();
  expect(report.reported).toBeUndefined();
  // Non-context custom entries and malformed rows contribute nothing.
  expect(report.conversation.total).toBe(0);
  expect(report.tools.buckets[0]?.label).toBe("circular");
});
