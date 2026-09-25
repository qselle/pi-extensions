import { expect, test } from "bun:test";
import {
  createPlanState,
  MAX_PLAN_DESCRIPTION_CHARS,
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

test("retains bounded step descriptions across persistence without changing title identity", () => {
  const plan = replacePlan(createPlanState(), [{ step: "Build", description: "  Verify\n\t\x1b[31mreload\x1b[0m and cancellation.  ", children: [
    { step: "Implement", status: "completed", description: "Keep the public API." },
    { step: "Verify", status: "in_progress", description: "   " },
  ] }]);
  expect(plan.items[0].description).toBe("Verify reload and cancellation.");
  expect(plan.items[0].children![1]).not.toHaveProperty("description");
  expect(decodePlanEntry({ version: 2, plan })?.plan).toEqual(plan);
  const next = replacePlan(plan, [{ ...plan.items[0], children: plan.items[0].children!.map((item) => ({ ...item, description: "Updated detail" })) }]);
  expect(next.items[0].children![0].status).toBe("completed");
  expect(() => validatePlanItems([{ step: "Build", status: "in_progress", description: "x".repeat(MAX_PLAN_DESCRIPTION_CHARS + 1) }])).toThrow("descriptions must be at most");
  expect(() => validatePlanItems([{ step: "Build", status: "in_progress", description: 42 as any }])).toThrow("descriptions must be text");
  expect(decodePlanEntry({ version: 1, plan: { ...plan, items: [{ step: "Bad", status: "in_progress", description: {} }] } })).toBeUndefined();
});

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

test("unfinished plans retain completed milestones when updating or finishing", () => {
  const current = replacePlan(createPlanState(), activeItems, "Working", 20);
  const before = JSON.stringify(current);
  for (const status of ["pending", "in_progress", "cancelled"] as const) {
    const next = activeItems.map((item, index) => ({ ...item, status: index === 0 ? status : index === 1 ? (status === "in_progress" ? "pending" : "in_progress") : item.status }));
    expect(() => replacePlan(current, next)).toThrow("Keep completed milestones");
  }
  expect(() => replacePlan(current, activeItems.slice(1))).toThrow("Inspect the current behavior");
  expect(() => replacePlan(current, [{ step: "Verify the integration", status: "completed" }])).toThrow("Keep completed milestones");
  expect(() => replacePlan(current, [])).toThrow("/plan clear");
  expect(JSON.stringify(current)).toBe(before);
  expect(replacePlan(current, activeItems.map((item) => ({ ...item, status: "completed" })))).toMatchObject({
    items: activeItems.map((item) => ({ ...item, status: "completed" })),
  });
});

test("completed milestone identity ignores case and whitespace but keeps group context", () => {
  const current = replacePlan(createPlanState(), [
    { step: "Backend", children: [{ step: "Verify API", status: "completed" }] },
    { step: "Frontend", children: [{ step: "Verify API", status: "completed" }, { step: "Release", status: "in_progress" }] },
  ]);
  const normalized = replacePlan(current, [
    { step: " FRONTEND ", children: [{ step: "verify   api", status: "completed" }, { step: "Release", status: "in_progress" }] },
    { step: " backend ", children: [{ step: "VERIFY API", status: "completed" }] },
  ]);
  expect(planStats(normalized.items).completed).toBe(2);
  expect(() => replacePlan(current, [
    { step: "Frontend", children: [{ step: "Verify API", status: "completed" }, { step: "Release", status: "in_progress" }] },
  ])).toThrow("Backend › Verify API");
});

test("future work can change while completed milestones remain", () => {
  const current = replacePlan(createPlanState(), activeItems);
  const next = replacePlan(current, [
    { step: "Inspect the current behavior", status: "completed" },
    { step: "Implementation", children: [{ step: "Implement API", status: "in_progress" }, { step: "Run integration", status: "pending" }] },
  ]);
  expect(planStats(next.items)).toMatchObject({ total: 3, completed: 1, inProgress: 1, pending: 1 });
});

test("an intentional objective reset needs a rationale and completed plans can start fresh", () => {
  const current = replacePlan(createPlanState(), activeItems);
  const next = [{ step: "New objective", status: "in_progress" as const }];
  expect(() => replacePlan(current, next, undefined, 30, true)).toThrow("requires an explanation");
  expect(() => replacePlan(current, next, "  ", 30, true)).toThrow("requires an explanation");
  expect(replacePlan(current, next, "User changed the release scope", 30, true)).toEqual({
    items: next, explanation: "User changed the release scope", updatedAt: 30,
  });
  const finished = replacePlan(current, activeItems.map((item) => ({ ...item, status: "completed" })));
  expect(replacePlan(finished, next).items).toEqual(next);
  const cancelled = replacePlan(createPlanState(), [{ step: "Retired work", status: "cancelled" }]);
  expect(replacePlan(cancelled, next).items).toEqual(next);
});
