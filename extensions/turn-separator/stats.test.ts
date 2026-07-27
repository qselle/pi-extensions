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
    expect(total).toEqual({ input: 150, output: 30, cacheRead: 900, cacheWrite: 5, cost: 0.03 });
  });

  test("ignores missing, negative, and non-finite values", () => {
    const total = addUsage(addUsage(emptyStats(), undefined), {
      input: -5, output: Number.NaN, cacheRead: undefined, cost: { total: -1 },
    });
    expect(total).toEqual(emptyStats());
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
    expect(tokensPerSecond(0, 1_000, 3_000)).toBeUndefined();
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
  test("pins duration and orders cost last", () => {
    const cells = statCells(124, stats({ input: 100, cacheRead: 4_100, output: 318, cost: 0.21, tps: 42, ttftMs: 480 }));
    expect(cells[0]).toEqual({ text: "Worked for 2m 4s", priority: 0 });
    expect(cells.map((cell) => cell.text)).toEqual([
      "Worked for 2m 4s",
      "↓4.2K ↑318",
      "cache 98%",
      "42 tps",
      "ttft 480ms",
      "$0.21",
    ]);
  });

  test("omits every absent metric", () => {
    expect(statCells(5, emptyStats()).map((cell) => cell.text)).toEqual(["Worked for 5s"]);
    expect(statCells(undefined, undefined)).toEqual([]);
  });

  test("skips sub-second durations", () => {
    expect(statCells(0, stats({ output: 5 })).some((cell) => cell.text.startsWith("Worked"))).toBe(false);
  });

  test("counts cached tokens in the input total", () => {
    const cells = statCells(undefined, stats({ input: 200, cacheRead: 800 }));
    expect(cells[0]?.text).toBe("↓1K");
  });
});

describe("statsLabel", () => {
  const full = stats({ input: 100, cacheRead: 4_100, output: 318, cost: 0.21, tps: 42, ttftMs: 480 });

  test("joins cells with a middle dot when everything fits", () => {
    expect(statsLabel(124, full, 200, width))
      .toBe("Worked for 2m 4s · ↓4.2K ↑318 · cache 98% · 42 tps · ttft 480ms · $0.21");
  });

  test("drops the least useful metrics first as width shrinks", () => {
    const at60 = statsLabel(124, full, 60, width);
    expect(at60).not.toContain("ttft");
    expect(at60).toContain("Worked for");
    expect(at60).toContain("$0.21");

    const at30 = statsLabel(124, full, 30, width);
    expect(at30).toContain("Worked for");
    expect(at30).not.toContain("tps");
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
  // The rule previously showed "↓4" and no cache segment while cost said $3.44,
  // hiding 545,886 tokens on the most expensive turn of the session.
  const cacheWriteTurn = stats({ input: 4, output: 1200, cacheRead: 0, cacheWrite: 545_886, cost: 3.4418075 });

  test("counts cache writes as prompt tokens", () => {
    expect(promptTokens(cacheWriteTurn)).toBe(545_890);
    expect(statCells(13, cacheWriteTurn)[1]?.text).toBe("↓546K ↑1.2K");
  });

  test("names a write-heavy turn explicitly", () => {
    const texts = statCells(13, cacheWriteTurn).map((cell) => cell.text);
    expect(texts).toContain("cache write 546K");
    expect(texts).toContain("$3.44");
  });

  test("keeps the cache write when the rule is narrow, because it is the cost driver", () => {
    const label = statsLabel(13, cacheWriteTurn, 45, width);
    expect(label).toBe("Worked for 13s · cache write 546K · $3.44");
  });

  test("drops tokens and throughput before the cache write", () => {
    const noisy = stats({ ...cacheWriteTurn, tps: 120, ttftMs: 480 });
    const label = statsLabel(13, noisy, 45, width);
    expect(label).not.toContain("tps");
    expect(label).not.toContain("ttft");
    expect(label).toContain("cache write 546K");
  });

  test("a cache-read turn shows the hit rate", () => {
    const readTurn = stats({ input: 2, output: 887, cacheRead: 545_886, cacheWrite: 1_536, cost: 0.304728 });
    const texts = statCells(5, readTurn).map((cell) => cell.text);
    expect(texts).toContain("cache 100% +1.5K");
    expect(texts).toContain("↓547K ↑887");
  });

  test("hit rate counts writes in the denominator", () => {
    expect(cacheHitRate(stats({ input: 0, cacheRead: 50, cacheWrite: 50 }))).toBeCloseTo(50, 5);
  });
});
