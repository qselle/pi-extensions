import { expect, test } from "bun:test";
import type { ContextReport, Section } from "./analysis.ts";
import { MAX_SECTION_ROWS, renderReport, summaryLine } from "./render.ts";

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
    largest: [{ id: "tool-results", label: "tool results", tokens: 8_100, detail: "bash" }],
    ...overrides,
  };
}

test("summarises estimate, provider count, share of window, and compaction point", () => {
  expect(summaryLine(report())).toBe("28.2K est · 27.9K reported · 11% of 258K · compaction at 238K");
});

test("omits figures pi has not provided", () => {
  expect(summaryLine(report({ reported: undefined, window: 0, compactAt: undefined })))
    .toBe("28.2K est");
  // Without a provider count the share falls back to the estimate.
  expect(summaryLine(report({ reported: undefined }))).toBe("28.2K est · 11% of 258K · compaction at 238K");
});

test("renders sections with aligned totals and per-bucket detail", () => {
  const lines = renderReport(report(), plain, 80);

  expect(lines[0]).toContain("Context");
  expect(lines[0]).toContain("28.2K est");
  const body = lines.slice(1).join("\n");
  expect(body).toContain("system prompt");
  expect(body).toContain("  pi base prompt");
  expect(body).toContain("12 bullets");
  expect(body).toContain("tool schemas");
  expect(body).toContain("  subagents");
  expect(body).toContain("conversation");
  // The whole point: an extension's own injection is a named line.
  expect(body).toContain("context: goal-context");
  expect(body).toContain("largest entries");
  expect(body).toContain("bash");

  // Totals share one right-aligned column, so their end position is constant.
  const valueEnd = (needle: string, value: string) => {
    const line = lines.find((candidate) => candidate.includes(needle))!;
    return line.indexOf(value) + value.length;
  };
  expect(valueEnd("system prompt", "6.1K")).toBe(valueEnd("pi base prompt", "3.2K"));
  expect(valueEnd("tool schemas", "3.4K")).toBe(valueEnd("subagents", "890"));
});

test("summarises the tail when a section has more buckets than fit", () => {
  const buckets = Array.from({ length: MAX_SECTION_ROWS + 3 }, (_, index) => ({
    id: `tool:t${index}`,
    label: `tool-${index}`,
    tokens: 100 - index,
  }));
  const lines = renderReport(report({ tools: section(1_000, buckets) }), plain, 80);
  const body = lines.join("\n");

  expect(body).toContain("… +3 more");
  // The three hidden buckets carry 94 + 93 + 92 tokens.
  expect(body).toContain("279");
  expect(body).not.toContain("tool-6 ");
});

test("drops empty sections entirely", () => {
  const lines = renderReport(
    report({ tools: section(0), conversation: section(0), largest: [] }),
    plain,
    80,
  );
  const body = lines.join("\n");

  expect(body).toContain("system prompt");
  expect(body).not.toContain("tool schemas");
  expect(body).not.toContain("conversation");
  expect(body).not.toContain("largest entries");
});

test("keeps every line inside the requested width, with or without styling", () => {
  for (const width of [24, 32, 48, 80, 120]) {
    for (const theme of [plain, ansi]) {
      for (const line of renderReport(report(), theme, width)) {
        const visible = line.replace(/\u001b\[[0-9;]*m/g, "");
        expect(visible.length).toBeLessThanOrEqual(width);
      }
    }
  }
});

test("degrades to a single line when the terminal is too narrow for a table", () => {
  const lines = renderReport(report(), plain, 18);

  expect(lines).toHaveLength(1);
  expect(lines[0].length).toBeLessThanOrEqual(18);
  expect(lines[0]).toContain("Context");
});
