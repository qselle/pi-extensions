import { describe, expect, test } from "bun:test";
import {
  addUsage,
  cacheHitRate,
  emptyStats,
  formatDuration,
  formatLatency,
  formatRate,
  hasStats,
  promptTokens,
  statCells,
  statsLabel,
  tokensPerSecond,
  type TurnStats,
} from "./stats.ts";

const width = (value: string) => [...value].length;

function stats(overrides: Partial<TurnStats> = {}): TurnStats {
  return { ...emptyStats(), ...overrides };
}

describe("formatDuration", () => {
  test("scales from seconds to hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(124)).toBe("2m 4s");
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(4_800)).toBe("1h 20m");
    expect(formatDuration(3_600)).toBe("1h");
  });
});

describe("addUsage", () => {
  test("accumulates every counter and the total cost", () => {
    let total = emptyStats();
    total = addUsage(total, { input: 100, output: 10, cacheRead: 900, cacheWrite: 5, cost: { total: 0.01 } });
    total = addUsage(total, { input: 50, output: 20, cost: { total: 0.02 } });
    expect(total).toEqual({ input: 150, output: 30, cacheRead: 900, cacheWrite: 5, cost: 0.03, responses: 2, missing: { cacheRead: 1, cacheWrite: 1 } });
  });

  test("ignores missing, negative, and non-finite values", () => {
    const total = addUsage(addUsage(emptyStats(), undefined), {
      input: -5, output: Number.NaN, cacheRead: undefined, cost: { total: -1 },
    });
    expect(total).toMatchObject({ ...emptyStats(), responses: 2, missing: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2, cost: 2 } });
  });
});

describe("cacheHitRate", () => {
  test("is the cached share of prompt tokens", () => {
    expect(cacheHitRate(stats({ input: 100, cacheRead: 900 }))).toBeCloseTo(90, 5);
  });
  test("is undefined without a prompt", () => {
    expect(cacheHitRate(emptyStats())).toBeUndefined();
  });
});

describe("hasStats", () => {
  test("is false for empty or missing stats", () => {
    expect(hasStats(undefined)).toBe(false);
    expect(hasStats(emptyStats())).toBe(false);
  });
  test("is true once anything was recorded", () => {
    expect(hasStats(stats({ output: 1 }))).toBe(true);
    expect(hasStats(stats({ ttftMs: 400 }))).toBe(true);
  });
});

describe("tokensPerSecond", () => {
  test("computes output tokens over the streaming window", () => {
    expect(tokensPerSecond(100, 1_000, 3_000)).toBeCloseTo(50, 5);
  });
  test("refuses samples that are too short or incomplete", () => {
    expect(tokensPerSecond(100, 1_000, 1_100)).toBeUndefined();
    expect(tokensPerSecond(0, 1_000, 3_000)).toBe(0);
    expect(tokensPerSecond(undefined, 1_000, 3_000)).toBeUndefined();
    expect(tokensPerSecond(100, undefined, 3_000)).toBeUndefined();
    expect(tokensPerSecond(100, 1_000, undefined)).toBeUndefined();
  });
});

describe("formatLatency / formatRate", () => {
  test("latency switches to seconds above 1s", () => {
    expect(formatLatency(480)).toBe("480ms");
    expect(formatLatency(1_240)).toBe("1.2s");
  });
  test("rate keeps a decimal only when slow", () => {
    expect(formatRate(42.4)).toBe("42");
    expect(formatRate(4.25)).toBe("4.3");
  });
});

describe("statCells", () => {
  test("ordinary work labels use one accent with neutral values and readable metadata", () => {
    const colors: Array<[string, string]> = [];
    statCells(42, stats({ input: 1200, output: 400, cacheRead: 8000, cacheWrite: 1500, cost: 0.04, ttftMs: 320, tps: 147 }), (color, text) => { colors.push([color, text]); return text; });
    expect(colors.filter(([color]) => color === "accent")).toEqual([["accent", "Worked for 42s"]]);
    expect(colors.some(([color]) => ["success", "warning", "error"].includes(color))).toBe(false);
    expect(colors).toContainEqual(["muted", "first token"]);
    expect(colors).toContainEqual(["text", "320ms"]);
    expect(colors).toContainEqual(["text", "1.5K"]);
  });
  test("pins duration and gives every metric a readable label", () => {
    const cells = statCells(124, stats({ input: 100, cacheRead: 4_100, output: 318, cost: 0.21, tps: 42, ttftMs: 480 }));
    expect(cells[0]).toEqual({ text: "Worked for 2m 4s", priority: 0 });
    expect(cells.map((cell) => cell.text)).toEqual([
      "Worked for 2m 4s",
      "in 100 · out 318",
      "$0.21",
      "cache hit 98%",
      "42 tokens/s",
      "first token 480ms",
      "cache read 4.1K",
    ]);
  });

  test("omits every absent metric", () => {
    expect(statCells(5, emptyStats()).map((cell) => cell.text)).toEqual(["Worked for 5s"]);
    expect(statCells(undefined, undefined)).toEqual([]);
  });

  test("labels sub-second durations without pretending they took one second", () => {
    expect(statCells(0, stats({ output: 5 }))[0]?.text).toBe("Worked for <1s");
  });

  test("input matches the footer fresh-input convention", () => {
    const cells = statCells(undefined, stats({ input: 200, cacheRead: 800 }));
    expect(cells[0]?.text).toBe("in 200");
  });

  test("recorded zero, missing usage and partial totals remain distinguishable", () => {
    const zero = addUsage(emptyStats(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });
    expect(hasStats(zero)).toBe(true);
    expect(statsLabel(0, zero, 100)).toBe("Worked for <1s · in 0 · out 0 · $0.00 · 1 reply");
    const unknown = addUsage(emptyStats(), undefined);
    expect(hasStats(unknown)).toBe(true);
    expect(statsLabel(1, unknown, 180)).toBe("Worked for 1s · in ? · out ? · $? · cache hit ? · 1 reply · cache read ? · cache write ?");
    const partial = addUsage(unknown, { input: 10, output: 5, cacheRead: 80, cacheWrite: 10, cost: { total: 0.01 } });
    expect(cacheHitRate(partial)).toBeUndefined();
    expect(statsLabel(1, partial, 180)).toBe("Worked for 1s · in ≥10 · out ≥5 · ≥$0.01 · cache hit ? · 2 replies · cache read ≥80 · cache write ≥10");
    expect(statsLabel(1, addUsage(emptyStats(), { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }), 100))
      .toContain("cache hit 0%");
  });
});

describe("statsLabel", () => {
  const full = stats({ input: 100, cacheRead: 4_100, output: 318, cost: 0.21, tps: 42, ttftMs: 480 });

  test("joins cells with a middle dot when everything fits", () => {
    expect(statsLabel(124, full, 200, width))
      .toBe("Worked for 2m 4s · in 100 · out 318 · $0.21 · cache hit 98% · 42 tokens/s · first token 480ms · cache read 4.1K");
  });

  test("drops the least useful metrics first as width shrinks", () => {
    const at60 = statsLabel(124, full, 60, width);
    expect(at60).not.toContain("first token");
    expect(at60).toContain("Worked for");
    expect(at60).toContain("$0.21");

    const at30 = statsLabel(124, full, 30, width);
    expect(at30).toContain("Worked for");
    expect(at30).not.toContain("tokens/s");
  });

  test("keeps duration and cost longest", () => {
    const tiny = statsLabel(124, full, 26, width);
    expect(tiny).toBe("Worked for 2m 4s · $0.21");
  });

  test("returns empty when even the pinned cell cannot fit", () => {
    expect(statsLabel(124, full, 4, width)).toBe("");
    expect(statsLabel(124, full, 0, width)).toBe("");
  });

  test("never exceeds the budget", () => {
    for (let budget = 5; budget <= 90; budget += 1) {
      expect(width(statsLabel(124, full, budget, width))).toBeLessThanOrEqual(budget);
    }
  });
});

describe("cache accounting (regression: real session data)", () => {
  // A real turn from a live session: the whole context was written to cache.
  // The rule previously showed only fresh input and no cache segment while cost said $3.44,
  // hiding 545,886 tokens on the most expensive turn of the session.
  const cacheWriteTurn = stats({ input: 4, output: 1200, cacheRead: 0, cacheWrite: 545_886, cost: 3.4418075 });

  test("counts cache writes as prompt tokens", () => {
    expect(promptTokens(cacheWriteTurn)).toBe(545_890);
    expect(statCells(13, cacheWriteTurn)[1]?.text).toBe("in 4 · out 1.2K");
  });

  test("names a write-heavy turn explicitly", () => {
    const texts = statCells(13, cacheWriteTurn).map((cell) => cell.text);
    expect(texts).toContain("cache write 546K");
    expect(texts).toContain("$3.44");
  });

  test("keeps input, output and cost when the rule is narrow", () => {
    const label = statsLabel(13, cacheWriteTurn, 45, width);
    expect(label).toBe("Worked for 13s · in 4 · out 1.2K · $3.44");
  });

  test("drops optional detail instead of abbreviating its labels", () => {
    const noisy = stats({ ...cacheWriteTurn, tps: 120, ttftMs: 480 });
    const label = statsLabel(13, noisy, 45, width);
    expect(label).not.toContain("tokens/s");
    expect(label).not.toContain("first token");
    expect(label).not.toContain("cache write");
    expect(label).toContain("in 4 · out 1.2K · $3.44");
  });

  test("a cache-read turn shows the hit rate", () => {
    const readTurn = stats({ input: 2, output: 887, cacheRead: 545_886, cacheWrite: 1_536, cost: 0.304728 });
    const texts = statCells(5, readTurn).map((cell) => cell.text);
    expect(texts).toContain("cache hit 100%");
    expect(texts).toContain("cache write 1.5K");
    expect(texts).toContain("in 2 · out 887");
  });

  test("hit rate counts writes in the denominator", () => {
    expect(cacheHitRate(stats({ input: 0, cacheRead: 50, cacheWrite: 50 }))).toBeCloseTo(50, 5);
  });
});
