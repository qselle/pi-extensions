import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { completionClock, completionRows, renderCompletion } from "./render.ts";
import { decodeSummary, emptySummary, recordResponse } from "./stats.ts";

const theme = { fg: (_color: string, value: string) => value } as Theme;
const plain = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
function example() {
  const summary = emptySummary();
  summary.endedAt = Date.UTC(2026, 8, 23, 12, 32, 5);
  summary.durationMs = 42_000;
  summary.tools = 2;
  recordResponse(summary, { usage: { input: 1200, output: 2100, cacheRead: 8400, cacheWrite: 0, cost: { total: 0.04 } } });
  summary.timing = { latencyMs: 320, latencySamples: 1, streamMs: 43_750, outputTokens: 2100, streamSamples: 1 };
  return summary;
}

test("compact completion is one rich line with no separate rule", () => {
  const summary = example();
  const rows = renderCompletion(summary, 160, theme, false);
  expect(rows).toHaveLength(1);
  expect(plain(rows[0])).toStartWith(" Turn 42s · in 1.2K · out 2.1K · $0.04 · cache hit 88%");
  expect(plain(rows[0])).toContain(`finished ${completionClock(summary)}`);
  expect(plain(rows[0])).toContain("48 tokens/s · first token 320ms · 1 reply · 2 tools · cache read 8.4K");
  expect(plain(rows[0])).not.toContain("─");
  expect(plain(rows[0])).not.toContain("cache write 0");
  expect(plain(renderCompletion(summary, 160, theme, true).join("\n"))).toContain("1/1 replies measured");
});

test("ordinary receipts use only one accent and preserve readable labels at 60, 100 and 180 columns", () => {
  const summary = example(); summary.usage.cacheWrite.known = 1500;
  const colors: Array<[string, string]> = [];
  const neutral = { fg: (color: string, value: string) => { colors.push([color, value]); return value; } } as Theme;
  renderCompletion(summary, 180, neutral, false);
  expect(colors.filter(([color]) => color === "accent")).toEqual([["accent", "Turn 42s"]]);
  expect(colors.some(([color]) => ["success", "warning", "error"].includes(color))).toBe(false);
  expect(colors).toContainEqual(["muted", "first token"]);
  expect(colors).toContainEqual(["text", "320ms"]);
  for (const width of [60, 100, 180]) {
    const [row] = renderCompletion(summary, width, theme, false);
    expect(row).toContain("Turn 42s · in 1.2K · out 2.1K · $0.04");
    expect(visibleWidth(row!)).toBeLessThanOrEqual(width);
    expect(row).not.toMatch(/ttft|[↓↑]|\d+r\/\d+t|hit\d/);
  }
  expect(renderCompletion(summary, 180, theme, false)[0]).toContain("cache write 1.5K");
});

test("compact width fitting always returns exactly one bounded row", () => {
  const summary = example();
  for (const expanded of [false, true]) {
    for (const width of [0, 1, 2, 3, 7, 30, 80, 120]) {
      const rows = renderCompletion(summary, width, theme, expanded);
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      if (!width) expect(rows).toEqual([]);
      else if (!expanded) expect(rows).toHaveLength(1);
    }
  }
  const readable = plain(renderCompletion(summary, 100, theme, false).join(" ")).replace(/\s+/g, " ");
  expect(readable).toContain("first token 320ms");
  expect(readable).toContain("48 tokens/s");
  expect(readable).toContain("$0.04");
});

test("narrow receipts drop low priority metrics before tokens and cost", () => {
  const summary = example();
  for (let width = 1; width <= 180; width++) {
    const rows = renderCompletion(summary, width, theme, false);
    expect(rows).toHaveLength(1);
    expect(visibleWidth(rows[0])).toBeLessThanOrEqual(width);
  }
  const narrow = plain(renderCompletion(summary, 40, theme, false)[0]);
  expect(narrow).toContain("42s"); expect(narrow).toContain("$0.04"); expect(narrow).toContain("in 1.2K · out 2.1K");
  expect(narrow).not.toContain("first token"); expect(narrow).not.toContain("cache read");
  const expanded = plain(renderCompletion(summary, 80, theme, true).join("\n"));
  expect(expanded).toContain("cache read: 8.4K"); expect(expanded).toContain("replies measured");
});

test("turn scope stays visible while the labeled completion clock drops first", () => {
  const summary = example();
  for (const width of [60, 100]) {
    const rows = renderCompletion(summary, width, theme, false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toStartWith(" Turn 42s · in 1.2K · out 2.1K · $0.04");
    expect(rows[0]).toContain("cache hit 88%");
    expect(rows[0]).not.toContain("finished");
  }
  expect(renderCompletion(summary, 180, theme, false)[0]).toContain(`finished ${completionClock(summary)}`);
  expect(completionRows(summary, theme)[0]).toContain("turn duration 42s");
});

test("partial totals, unknown timing and measured zeros remain distinct in the compact row", () => {
  const summary = emptySummary();
  recordResponse(summary, { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });
  let row = completionRows(summary, theme).join("\n");
  expect(row).toContain("prompt 0 · in 0 · out 0 · cache read 0 · cache write 0 · cache hit — · cost $0.00");
  expect(row).toContain("first token avg ? (0/1 replies) · rate unknown (0/1 replies)");
  expect(row).not.toContain("partial usage");
  expect(renderCompletion(summary, 160, theme, false)[0]).toContain("in 0 · out 0 · $0.00");
  expect(renderCompletion(summary, 160, theme, false)[0]).not.toMatch(/tokens\/s|first token|cache write/);
  summary.timing = { latencyMs: 0, latencySamples: 1, streamMs: 1000, outputTokens: 0, streamSamples: 1 };
  expect(renderCompletion(summary, 160, theme, false)[0]).toContain("0.0 tokens/s · first token 0ms");
  summary.timing = undefined;
  recordResponse(summary, {});
  row = completionRows(summary, theme).join("\n");
  expect(row).toContain("prompt ≥0 · in ≥0 · out ≥0 · cache read ≥0 · cache write ≥0 · cache hit ? · cost ≥$0.00 · partial usage");
  expect(row).toContain("first token avg ? (0/2 replies) · rate unknown (0/2 replies)");
  const unknown = emptySummary(); recordResponse(unknown, {});
  expect(completionRows(unknown, theme)[1]).toBe("prompt ? · in ? · out ? · cache read ? · cache write ? · cache hit ? · cost ? · partial usage");
  expect(renderCompletion(unknown, 160, theme, false)[0]).toContain("in ? · out ? · $? · cache hit ?");
});

test("prompt volume includes fresh input and both caches; zero hits are explicit and partial denominators stay unknown", () => {
  const summary = emptySummary();
  recordResponse(summary, { usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 400, cost: { total: 0.01 } } });
  expect(completionRows(summary, theme)[1]).toBe("prompt 500 · in 100 · out 20 · cache read 0 · cache write 400 · cache hit 0% · cost $0.01");
  recordResponse(summary, { usage: { cacheRead: 500 } });
  const partial = completionRows(summary, theme)[1];
  expect(partial).toStartWith("prompt ≥1K · in ≥100 · out ≥20 · cache read 500 · cache write ≥400 · cache hit ?");
  const cacheOnly = emptySummary(); recordResponse(cacheOnly, { usage: { cacheRead: 500 } });
  expect(completionRows(cacheOnly, theme)[1]).toStartWith("prompt ≥500 · in ? · out ? · cache read 500 · cache write ? · cache hit ?");
});

test("partial timing coverage and failure states remain visible with semantic colors", () => {
  const summary = example();
  summary.responses = 3;
  summary.tools = 2;
  summary.failedTools = 1;
  summary.outcome = "interrupted";
  const colors: Array<[string, string]> = [];
  const semantic = { fg: (color: string, value: string) => { colors.push([color, value]); return value; } } as Theme;
  const row = completionRows(summary, semantic).join("\n");
  expect(row).toStartWith("interrupted · 1 failed tool · ");
  expect(row).toContain("3 replies · 2 tools · first token avg 320ms (1/3 replies) · rate 48 tokens/s (1/3 replies)");
  expect(colors).toContainEqual(["warning", "interrupted"]);
  expect(colors).toContainEqual(["error", "1 failed tool"]);
  expect(colors).toContainEqual(["muted", "turn duration"]);
  expect(colors).toContainEqual(["text", "320ms"]);
  expect(colors).toContainEqual(["text", "88%"]);
  expect(colors).toContainEqual(["text", "$0.04"]);
  const compact = renderCompletion(summary, 160, semantic, false)[0];
  expect(compact).toContain("interrupted · 1 failed tool · Turn 42s");
  expect(compact).toContain("48 tokens/s (1/3 replies) · first token 320ms (1/3 replies)");
  summary.outcome = "error";
  expect(completionRows(summary, semantic)[0]).toStartWith("error · ");
  expect(colors).toContainEqual(["error", "error"]);
});

test("legacy entries use their saved timestamp while unknown and invalid clocks are never invented", () => {
  const summary = example();
  const expected = completionClock(summary);
  expect(expected).toMatch(/^\d{2}:\d{2}:05$/);
  const timestamp = new Date(summary.endedAt!).toISOString();
  delete summary.endedAt;
  expect(decodeSummary(summary)).toBeDefined();
  expect(completionClock(summary, timestamp)).toBe(expected);
  expect(completionClock(summary)).toBeUndefined();
  expect(completionClock(summary, "invalid")).toBeUndefined();
  for (const endedAt of [-1, Infinity, NaN, 8.64e15 + 1]) expect(decodeSummary({ ...summary, endedAt })).toBeUndefined();
});
