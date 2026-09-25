import { expect, test } from "bun:test";
import { createGoal, decodeGoalEntry, setGoalStatus, type GoalState } from "./goal.ts";
import { assertGoalIdentity, assertGoalReconciled, reconcileGoal, requireGoalReconciliation, resumeGoalForRequest } from "./reconciliation.ts";

function pendingGoal(): GoalState {
  return requireGoalReconciliation({
    ...createGoal("Implement and verify the whole feature", { id: "goal-1", now: 1, tokenBudget: 20_000 }),
    checks: [{ content: "Implementation", status: "complete" }, { content: "Validation", status: "in_progress" }],
    tokensUsed: 8_500, timeUsedMs: 95_000, turns: 8, runTurns: 3, continuations: 5,
    progressSummary: "Initial implementation is ready",
  }, "request-1", 100);
}

test("revisions require the full scope and checks, and preserve identity and lifetime accounting", () => {
  const original = pendingGoal();
  expect(() => reconcileGoal(original, "request-1", "revise", { objective: "Add explicit validation" })).toThrow("complete checks list");
  expect(() => reconcileGoal(original, "request-1", "revise", { checks: [] })).toThrow("complete objective");
  expect(() => reconcileGoal(original, "request-1", "revise", { objective: "New scope", checks: [{ content: "Test", status: "pending" }] })).toThrow("exactly one");
  expect(original.reconciliation?.requestId).toBe("request-1");

  const revised = reconcileGoal(original, "request-1", "revise", {
    objective: "Implement and verify the whole feature, including migration",
    checks: [...original.checks, { content: "Migration", status: "pending" }],
  }, 200);
  for (const key of ["id", "tokenBudget", "tokensUsed", "timeUsedMs", "turns", "runTurns", "continuations", "createdAt"] as const) {
    expect(revised[key]).toBe(original[key]);
  }
  expect(revised.checks).toHaveLength(3);
  expect(revised.progressSummary).toBeUndefined();
  expect(revised.reconciliation).toBeUndefined();
  expect(revised.updatedAt).toBe(200);
  expect(original.objective).toBe("Implement and verify the whole feature");
  expect(original.checks).toHaveLength(2);
});

test("only the current goal and user request may be reconciled", () => {
  const goal = pendingGoal();
  expect(() => assertGoalIdentity(goal, "different-goal")).toThrow("goal changed");
  expect(() => assertGoalIdentity(undefined, "goal-1")).toThrow("goal changed");
  expect(() => reconcileGoal(goal, "old-request", "keep")).toThrow("request changed");
  expect(() => assertGoalReconciled(goal)).toThrow("reconcile_goal");
  const kept = reconcileGoal(goal, "request-1", "keep");
  expect(kept.objective).toBe(goal.objective);
  expect(kept.checks).toEqual(goal.checks);
  expect(() => assertGoalReconciled(kept)).not.toThrow();
  expect(() => reconcileGoal(kept, "request-1", "keep")).toThrow("request changed");
  expect(() => reconcileGoal(goal, "request-1", "keep", { checks: [] })).toThrow("only with action revise");
});

test("inactive scope reconciliation cannot resume work; explicit resume starts a fresh blocker audit", () => {
  const goal = { ...setGoalStatus(pendingGoal(), "blocked"), noToolTurns: 2,
    blockerAudit: { fingerprint: "blocker", description: "External service unavailable", count: 3, lastReportedTurn: 8 } };
  const kept = reconcileGoal(goal, "request-1", "keep");
  expect(kept.status).toBe("blocked");
  expect(kept.blockerAudit?.count).toBe(3);
  const resumed = resumeGoalForRequest(kept, 200);
  expect(resumed.status).toBe("active");
  expect(resumed.reconciliation?.requestId).toBeDefined();
  expect(resumed.blockerAudit).toBeUndefined();
  expect(resumed.runTurns).toBe(0);
  expect(resumed.noToolTurns).toBe(0);
  for (const key of ["id", "tokenBudget", "tokensUsed", "timeUsedMs", "turns", "continuations", "createdAt"] as const) expect(resumed[key]).toBe(goal[key]);
});

test("pause clears the request without losing the goal and resume never bypasses exhausted budgets", () => {
  const paused = reconcileGoal(pendingGoal(), "request-1", "pause");
  expect(paused.status).toBe("paused");
  expect(paused.reconciliation).toBeUndefined();
  expect(() => resumeGoalForRequest(pendingGoal())).toThrow("already active");
  expect(() => resumeGoalForRequest(setGoalStatus(paused, "complete"))).toThrow("complete");
  expect(() => resumeGoalForRequest({ ...paused, tokensUsed: 20_000 })).toThrow("budget is exhausted");
  expect(() => resumeGoalForRequest(setGoalStatus(paused, "budget_limited"))).toThrow("budget is exhausted");
});

test("pending reconciliation survives state persistence and malformed tokens are not accepted", () => {
  const goal = pendingGoal();
  expect(decodeGoalEntry(JSON.parse(JSON.stringify({ version: 2, goal })))?.goal?.reconciliation).toEqual(goal.reconciliation);
  expect(decodeGoalEntry({ version: 2, goal: { ...goal, reconciliation: { requestId: "", requestedAt: 0 } } })).toBeUndefined();
  expect(decodeGoalEntry({ version: 2, goal: { ...goal, reconciliation: { requestId: "request-1", requestedAt: -1 } } })).toBeUndefined();
});
