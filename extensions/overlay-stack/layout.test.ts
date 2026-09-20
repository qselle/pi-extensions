import { expect, test } from "bun:test";
import { bodyBudgets } from "./layout.ts";

test("body space is shared after minimums, with stable priority for odd rows", () => {
  expect(bodyBudgets([1, 1, 1], 12)).toEqual([4, 4, 4]);
  expect(bodyBudgets([1, 3, 1], 12)).toEqual([4, 5, 3]);
  expect(bodyBudgets([4, 4], 8)).toEqual([4, 4]);
  expect(bodyBudgets([], 10)).toEqual([]);
});
