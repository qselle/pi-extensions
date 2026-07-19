import { expect, test } from "bun:test";
import {
  pickRandomDelay,
  SMART_IDLE_DELAY_MS,
  SMART_WORKING_DELAY_MS,
} from "./animation.ts";

test("smart idle animation waits longer than working animation", () => {
  expect(SMART_IDLE_DELAY_MS.min).toBeGreaterThan(SMART_WORKING_DELAY_MS.max);
});

test("random delay stays inside its configured range", () => {
  const range = { min: 100, max: 200 } as const;
  expect(pickRandomDelay(range, () => 0)).toBe(100);
  expect(pickRandomDelay(range, () => 0.5)).toBe(150);
  expect(pickRandomDelay(range, () => 1)).toBe(200);
});
