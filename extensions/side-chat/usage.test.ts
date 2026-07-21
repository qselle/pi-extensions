import { expect, test } from "bun:test";
import {
  addSideUsage,
  emptySideUsage,
  formatSideUsage,
  formatTokens,
  isEmptyUsage,
  normalizeSideUsage,
} from "./usage.ts";

test("emptySideUsage is zeroed and detected as empty", () => {
  const empty = emptySideUsage();
  expect(empty).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  expect(isEmptyUsage(empty)).toBe(true);
});

test("addSideUsage sums each field", () => {
  const sum = addSideUsage(
    { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 },
    { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 1.5 },
  );
  expect(sum).toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44, cost: 2 });
});

test("normalizeSideUsage reads a provider usage object with nested cost", () => {
  const normalized = normalizeSideUsage({
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 5,
    cost: { input: 0.1, output: 0.2, total: 0.42 },
  });
  expect(normalized).toEqual({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.42 });
});

test("normalizeSideUsage tolerates missing, negative, and flat cost values", () => {
  expect(normalizeSideUsage(undefined)).toEqual(emptySideUsage());
  expect(normalizeSideUsage({ input: -5, cost: 0.3 })).toEqual({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.3,
  });
});

test("formatSideUsage renders a compact label or nothing when empty", () => {
  expect(formatSideUsage(emptySideUsage())).toBeUndefined();
  expect(formatSideUsage({ input: 12_000, output: 850, cacheRead: 20_000, cacheWrite: 0, cost: 0.0421 })).toBe(
    "side ↑12k ↓850 R20k $0.0421",
  );
  expect(formatSideUsage({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, "agents")).toBe("agents ↑5");
});

test("formatTokens scales with magnitude", () => {
  expect(formatTokens(999)).toBe("999");
  expect(formatTokens(1_500)).toBe("1.5k");
  expect(formatTokens(20_000)).toBe("20k");
  expect(formatTokens(2_000_000)).toBe("2.0M");
});
