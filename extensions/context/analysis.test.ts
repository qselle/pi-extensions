import { expect, test } from "bun:test";
import { analyzeContext, shortenPath, type AnalyzeInput, type Estimators } from "./analysis.ts";

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

test("matches Pi's guideline normalization and active snippet selection", () => {
  const report = analyze({
    systemPrompt: "x".repeat(400),
    selectedTools: ["read"],
    promptGuidelines: [" keep this ", "keep this", "  "],
    toolSnippets: { read: "read files", dormant: "not in the prompt" },
  });
  const byId = new Map(report.system.buckets.map((bucket) => [bucket.id, bucket]));

  expect(byId.get("guidelines")?.detail).toBe("1 bullet");
  expect(byId.get("guidelines")?.tokens).toBe(3);
  expect(byId.get("snippets")?.detail).toBe("1 tool");
  expect(byId.get("snippets")?.tokens).toBe(3);
});

test("never reports a negative base prompt when parts exceed the measured prompt", () => {
  const report = analyze({
    systemPrompt: "x",
    contextFiles: [
      { path: "big.md", content: "y".repeat(400) },
      { path: "also-big.md", content: "z".repeat(400) },
    ],
  });

  expect(report.system.total).toBe(1);
  expect(report.system.buckets.find((bucket) => bucket.id === "base")).toBeUndefined();
  expect(report.system.buckets.every((bucket) => bucket.tokens > 0)).toBe(true);
  expect(report.system.buckets.reduce((sum, bucket) => sum + bucket.tokens, 0)).toBe(report.system.total);
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

test("measures the skill descriptors Pi actually places in the prompt", () => {
  const report = analyze({
    systemPrompt: "x".repeat(800),
    selectedTools: ["read"],
    skills: [
      {
        name: "review",
        description: "Review changes carefully",
        filePath: "/skills/review/SKILL.md",
        disableModelInvocation: false,
      },
      {
        name: "manual-only",
        description: "Only invoked explicitly",
        filePath: "/skills/manual/SKILL.md",
        disableModelInvocation: true,
      },
    ],
  });

  const skill = report.system.buckets.find((bucket) => bucket.id === "skill:review");
  expect(skill?.tokens).toBeGreaterThan(0);
  expect(report.system.buckets.some((bucket) => bucket.id === "skill:manual-only")).toBe(false);
});

test("omits skill descriptors when the read tool is inactive", () => {
  const report = analyze({
    systemPrompt: "x".repeat(400),
    selectedTools: ["bash"],
    skills: [{ name: "review", description: "Review changes", filePath: "/skills/review/SKILL.md" }],
  });

  expect(report.system.buckets.some((bucket) => bucket.id === "skill:review")).toBe(false);
});

test("does not attribute default guidelines or snippets under a custom prompt", () => {
  const report = analyze({
    systemPrompt: "custom prompt",
    customPrompt: "custom prompt",
    promptGuidelines: ["unused guideline"],
    toolSnippets: { read: "unused snippet" },
  });

  expect(report.system.buckets.map((bucket) => bucket.id)).toEqual(["custom-prompt"]);
  expect(report.system.buckets[0]?.tokens).toBe(report.system.total);
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
      { type: "custom_message", customType: "memory-context", content: "remember this", tokens: 70 },
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
  expect(byId.get("custom:memory-context")?.tokens).toBe(70);
  expect(report.conversation.total).toBe(2970);
  expect(report.conversation.buckets[0]?.id).toBe("compaction");
});

test("splits assistant content while preserving the entry's exact token total", () => {
  const report = analyze({
    entries: [message("assistant", 101, {
      content: [
        { type: "thinking", thinking: "r".repeat(40) },
        { type: "text", text: "a".repeat(20) },
        { type: "toolCall", name: "read", arguments: { path: "x.ts" } },
      ],
    })],
  });

  const byId = new Map(report.conversation.buckets.map((bucket) => [bucket.id, bucket]));
  expect(byId.get("assistant-reasoning")?.tokens).toBeGreaterThan(byId.get("assistant-answers")?.tokens ?? 0);
  expect(byId.get("assistant-tool-calls")?.tokens).toBeGreaterThan(0);
  expect(report.conversation.total).toBe(101);
});

test("excludes shell executions that Pi marks as outside model context", () => {
  const report = analyze({
    entries: [
      message("bashExecution", 500, { command: "secret", output: "hidden", excludeFromContext: true }),
      message("bashExecution", 40, { command: "pwd", output: "/work", excludeFromContext: false }),
    ],
  });

  expect(report.conversation.buckets).toEqual([
    { id: "bash-executions", label: "shell executions", tokens: 40, detail: "1 entry" },
  ]);
  expect(report.conversation.total).toBe(40);
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
  // Position keeps otherwise identical rows apart.
  expect(report.largest[0]).toMatchObject({ label: "tool results", detail: "bash #1" });
  expect(report.largest[1]).toMatchObject({ label: "assistant message", detail: "#2" });
});

test("shortens context-file labels so numbers stay on screen", () => {
  const cwd = "/Users/me/project";
  const home = "/Users/me";

  expect(shortenPath(`${cwd}/AGENTS.md`, cwd, home)).toBe("AGENTS.md");
  expect(shortenPath(`${cwd}/docs/guide.md`, cwd, home)).toBe("docs/guide.md");
  expect(shortenPath(`${home}/notes/todo.md`, cwd, home)).toBe("~/notes/todo.md");
  expect(shortenPath("/etc/pi/shared.md", cwd, home)).toBe("shared.md");
  expect(shortenPath("C:\\Users\\me\\project\\docs\\guide.md", "C:\\Users\\me\\project", "C:\\Users\\me"))
    .toBe("docs/guide.md");
  expect(shortenPath("C:\\Users\\me\\notes\\todo.md", "D:\\work", "C:\\Users\\me"))
    .toBe("~/notes/todo.md");
  expect(shortenPath("", cwd, home)).toBe("context file");
});

test("removes terminal escape sequences from persisted labels", () => {
  const report = analyze({
    systemPrompt: "rules",
    contextFiles: [{ path: "\u001b[31mAGENTS.md\u001b[0m", content: "rules" }],
    entries: [{ type: "custom_message", customType: "\u001b]8;;https://bad.example\u0007goal\u001b]8;;\u0007", content: "x", tokens: 1 }],
  });

  expect(report.system.buckets[0]?.label).toBe("AGENTS.md");
  expect(report.conversation.buckets[0]?.label).toBe("context: goal");
});

test("totals the three regions and records the context window", () => {
  const report = analyze({
    systemPrompt: "x".repeat(40),
    tools: [{ name: "t", description: "y".repeat(36) }],
    entries: [message("user", 500)],
    window: 200_000,
    reportedTokens: 1234,
  });

  expect(report.estimated).toBe(report.system.total + report.tools.total + report.conversation.total);
  expect(report.window).toBe(200_000);
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
  expect(report.reported).toBeUndefined();
  // Non-context custom entries and malformed rows contribute nothing.
  expect(report.conversation.total).toBe(0);
  expect(report.tools.buckets[0]?.label).toBe("circular");
});
