import { expect, test } from "bun:test";
import {
  createPlanState,
  currentPlanItem,
  decodePlanEntry,
  planIsActive,
  planResponse,
  planStats,
  replacePlan,
  validatePlanItems,
  type PlanItem,
} from "./plan.ts";

const activeItems: PlanItem[] = [
  { step: "Inspect the current behavior", status: "completed" },
  { step: "Implement the plan extension", status: "in_progress" },
  { step: "Verify the integration", status: "pending" },
];

test("replaces and normalizes the complete plan", () => {
  const plan = replacePlan(
    createPlanState(10),
    [{ step: "  Implement   the feature ", status: "in_progress" }],
    "  Chose   the smallest design ",
    20,
  );
  expect(plan).toEqual({
    items: [{ step: "Implement the feature", status: "in_progress" }],
    explanation: "Chose the smallest design",
    updatedAt: 20,
  });
});

test("requires exactly one current step while work remains", () => {
  expect(() => validatePlanItems([
    { step: "First", status: "pending" },
    { step: "Second", status: "pending" },
  ])).toThrow("exactly one in-progress");
  expect(() => validatePlanItems([
    { step: "First", status: "in_progress" },
    { step: "Second", status: "in_progress" },
  ])).toThrow("Only one");
  expect(validatePlanItems([
    { step: "First", status: "completed" },
    { step: "Second", status: "cancelled" },
  ])).toHaveLength(2);
  expect(validatePlanItems([])).toEqual([]);
});

test("rejects duplicate, empty, and oversized plans", () => {
  expect(() => validatePlanItems([
    { step: "Same step", status: "in_progress" },
    { step: "same step", status: "pending" },
  ])).toThrow("Duplicate plan step");
  expect(() => validatePlanItems([{ step: " ", status: "in_progress" }])).toThrow("must not be empty");
  expect(() => validatePlanItems(Array.from({ length: 11 }, (_, index) => ({
    step: `Step ${index}`,
    status: index === 0 ? "in_progress" as const : "pending" as const,
  })))).toThrow("at most 10");
});

test("computes progress and selects the live step", () => {
  const plan = replacePlan(createPlanState(), activeItems);
  expect(planStats(plan.items)).toEqual({
    completed: 1,
    cancelled: 0,
    finished: 1,
    inProgress: 1,
    pending: 1,
    unfinished: 2,
    total: 3,
  });
  expect(currentPlanItem(plan)?.step).toBe("Implement the plan extension");
  expect(planIsActive(plan)).toBe(true);
});

test("restores only valid versioned state", () => {
  const plan = replacePlan(createPlanState(10), activeItems, "Working", 20);
  expect(decodePlanEntry({ version: 1, plan })).toEqual({ version: 1, plan });
  expect(decodePlanEntry({ version: 3, plan })).toBeUndefined();
  expect(decodePlanEntry({ version: 1, plan: { ...plan, items: [{ step: "Broken", status: "pending" }] } })).toBeUndefined();
  expect(decodePlanEntry(null)).toBeUndefined();
});

test("returns structured plan state to commands and tools", () => {
  const plan = replacePlan(createPlanState(), activeItems, "Executing the design", 25);
  expect(JSON.parse(planResponse(plan))).toEqual({
    plan: {
      items: activeItems,
      explanation: "Executing the design",
      progress: { finished: 1, completed: 1, cancelled: 0, total: 3 },
      active: true,
      updatedAt: 25,
    },
  });
});

test("nested groups derive progress from leaves without double-counting parents", () => {
  const plan = replacePlan(createPlanState(), [
    { step: "Build", status: "completed", children: [{ step: "Implement", status: "completed" }, { step: "Verify", status: "in_progress" }] },
    { step: "Ship", children: [{ step: "Verify", status: "pending" }, { step: "Deprecated route", status: "cancelled" }] },
  ]);
  expect(plan.items[0]?.status).toBe("in_progress");
  expect(plan.items[1]?.status).toBe("pending");
  expect(planStats(plan.items)).toMatchObject({ total: 4, finished: 2, completed: 1, cancelled: 1, inProgress: 1 });
  expect(currentPlanItem(plan)?.step).toBe("Verify");
  expect(decodePlanEntry({ version: 2, plan })).toEqual({ version: 2, plan });
});
test("nested plans enforce depth, total size and one current leaf", () => {
  expect(() => validatePlanItems([{ step: "A", children: [{ step: "B", children: [{ step: "C", children: [{ step: "D", status: "in_progress" }] }] }] }])).toThrow("3 levels");
  expect(() => validatePlanItems([{ step: "A", children: [] }])).toThrow("at least one");
  expect(() => validatePlanItems([{ step: "A", children: [{ step: "a", status: "in_progress" }] }, { step: "B", children: [{ step: "b", status: "in_progress" }] }])).toThrow("Only one");
  expect(() => validatePlanItems(Array.from({ length: 5 }, (_, i) => ({ step: `Group ${i}`, children: Array.from({ length: 8 }, (_, j) => ({ step: `Child ${j}`, status: "completed" as const })) })))).toThrow("40 groups");
});
test("cancelled children remain distinct from successfully completed work", () => {
  const plan = replacePlan(createPlanState(), [{ step: "Removed", children: [{ step: "Unused", status: "cancelled" }] }, { step: "Delivered", children: [{ step: "Build", status: "completed" }, { step: "Unused", status: "cancelled" }] }]);
  expect(plan.items[0]?.status).toBe("cancelled");
  expect(plan.items[1]?.status).toBe("completed");
  expect(planStats(plan.items)).toMatchObject({ completed: 1, cancelled: 2, total: 3 });
});
