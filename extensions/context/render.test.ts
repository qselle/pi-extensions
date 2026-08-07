import { expect, test } from "bun:test";
import type { ContextReport, Section } from "./analysis.ts";
import { formatCount, MAX_SECTION_ROWS, renderReport, summaryLine } from "./render.ts";

const plain = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const ansi = {
  fg: (_color: string, text: string) => `\u001b[2m${text}\u001b[0m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
};

function section(total: number, buckets: Section["buckets"] = []): Section {
  return { total, buckets };
}

function report(overrides: Partial<ContextReport> = {}): ContextReport {
  return {
    window: 258_000,
    compactAt: 238_000,
    estimated: 28_200,
    reported: 27_900,
    system: section(6_100, [
      { id: "base", label: "pi base prompt", tokens: 3_200 },
      { id: "guidelines", label: "guidelines", tokens: 1_900, detail: "12 bullets" },
      { id: "file:AGENTS.md", label: "AGENTS.md", tokens: 1_000 },
    ]),
    tools: section(3_400, [
      { id: "tool:subagents", label: "subagents", tokens: 890 },
      { id: "tool:memory", label: "memory", tokens: 640 },
    ]),
    conversation: section(18_700, [
      { id: "tool-results", label: "tool results", tokens: 14_800, detail: "12 entries" },
      { id: "custom:goal-context", label: "context: goal-context", tokens: 850, detail: "3 entries" },
    ]),
    largest: [{ id: "tool-results", label: "tool results", tokens: 8_100, detail: "bash #391" }],
    ...overrides,
  };
}

const lineFor = (lines: string[], needle: string) => lines.find((line) => line.includes(needle)) ?? "";

test("groups digits so rows are directly comparable", () => {
  expect(formatCount(321_234)).toBe("321,234");
  expect(formatCount(1_000_000)).toBe("1,000,000");
  expect(formatCount(999)).toBe("999");
  expect(formatCount(-5)).toBe("0");
});

test("leads with the figure that actually drives compaction", () => {
  // pi's own count wins the headline; the estimate is reconciled in a footnote.
  expect(summaryLine(report())).toBe("Used 27,900 / 258,000 (11%) · compacts at 238,000");
});

test("falls back to the estimate and omits figures pi has not provided", () => {
  expect(summaryLine(report({ reported: undefined })))
    .toBe("Used 28,200 / 258,000 (11%) · compacts at 238,000");
  expect(summaryLine(report({ reported: undefined, window: 0, compactAt: undefined })))
    .toBe("Used 28,200");
});

test("orders regions by weight so the window hog is the first thing read", () => {
  const lines = renderReport(report(), plain, 80);
  const order = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^(conversation|tool schemas|system prompt)/.test(line))
    .map(({ line }) => line.split(/\s{2,}/)[0]);

  expect(order).toEqual(["conversation", "system prompt", "tool schemas"]);
});

test("shows each row's share of the estimated total", () => {
  const lines = renderReport(report(), plain, 80);

  // 18,700 / 28,200 = 66%; 14,800 / 28,200 = 52%.
  expect(lineFor(lines, "conversation")).toContain("66%");
  expect(lineFor(lines, "tool results")).toContain("52%");
  expect(lineFor(lines, "guidelines")).toContain("12 bullets");
});

test("reconciles the estimate against pi's figure, naming the provider's components", () => {
  const withComponents = renderReport(
    report({ provider: { input: 15_110, output: 6_400, cacheRead: 600_000, cacheWrite: 26_923 } }),
    plain,
    100,
  );

  expect(lineFor(withComponents, "estimated total")).toContain("28,200");
  const providerLine = lineFor(withComponents, "provider last turn");
  expect(providerLine).toContain("27,900");
  // A 2x gap against the estimate is cache accounting, so name the parts.
  expect(providerLine).toContain("15,110 fresh + 626,923 cached");
  expect(providerLine).toContain("6,400 out");

  // Without components, fall back to a plain explanation.
  expect(lineFor(renderReport(report(), plain, 100), "provider last turn"))
    .toContain("counts cached reuse");

  const withoutProvider = renderReport(report({ reported: undefined }), plain, 80);
  expect(lineFor(withoutProvider, "provider last turn")).toBe("");
  expect(lineFor(withoutProvider, "estimated total")).toContain("28,200");
});

test("keeps identical largest entries apart", () => {
  const lines = renderReport(report(), plain, 80);

  expect(lineFor(lines, "largest entries")).not.toBe("");
  expect(lineFor(lines, "8,100")).toContain("bash #391");
});

test("summarises the tail when a section has more buckets than fit", () => {
  const buckets = Array.from({ length: MAX_SECTION_ROWS + 3 }, (_, index) => ({
    id: `tool:t${index}`,
    label: `tool-${index}`,
    tokens: 100 - index,
  }));
  const lines = renderReport(report({ tools: section(1_000, buckets) }), plain, 80);

  // The three hidden buckets carry 94 + 93 + 92 tokens.
  expect(lineFor(lines, "… +3 more")).toContain("279");
  expect(lineFor(lines, "tool-6")).toBe("");
});

test("drops empty regions entirely", () => {
  const lines = renderReport(
    report({ tools: section(0), conversation: section(0), largest: [] }),
    plain,
    80,
  );

  expect(lineFor(lines, "system prompt")).not.toBe("");
  expect(lineFor(lines, "tool schemas")).toBe("");
  expect(lineFor(lines, "conversation")).toBe("");
  expect(lineFor(lines, "largest entries")).toBe("");
});

test("right-aligns every number into one column", () => {
  const lines = renderReport(report(), plain, 80);
  const endOf = (needle: string, value: string) => {
    const line = lineFor(lines, needle);
    return line.indexOf(value) + value.length;
  };

  expect(endOf("conversation", "18,700")).toBe(endOf("tool results", "14,800"));
  expect(endOf("system prompt", "6,100")).toBe(endOf("pi base prompt", "3,200"));
  expect(endOf("estimated total", "28,200")).toBe(endOf("subagents", "890"));
});

test("stays inside the requested width and never leaves trailing blanks", () => {
  for (const width of [28, 36, 52, 80, 120]) {
    for (const theme of [plain, ansi]) {
      for (const line of renderReport(report(), theme, width)) {
        const visible = line.replace(/\u001b\[[0-9;]*m/g, "");
        expect(visible.length).toBeLessThanOrEqual(width);
        expect(visible).toBe(visible.replace(/\s+$/, ""));
      }
    }
  }
});

test("degrades to a single line when the terminal is too narrow for a table", () => {
  const lines = renderReport(report(), plain, 20);

  expect(lines).toHaveLength(1);
  expect(lines[0].length).toBeLessThanOrEqual(20);
  expect(lines[0]).toContain("Context");
});
