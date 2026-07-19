import { expect, test } from "bun:test";
import {
  BLOCKED_AUDIT_TURNS,
  accountGoalUsage,
  beginGoalRun,
  clearGoalBlockerAudit,
  createGoal,
  currentGoalCheck,
  decodeGoalEntry,
  editGoalObjective,
  formatDuration,
  formatTokens,
  goalCheckProgress,
  goalChecksComplete,
  recordGoalBlocker,
  reportGoalProgress,
  setGoalStatus,
  validateGoalChecks,
  validateObjective,
  type GoalCheck,
} from "./goal.ts";

function goal(objective = "Ship the feature") {
  return createGoal(objective, { id: "goal-1", now: 100, tokenBudget: 1_000 });
}

const checks: GoalCheck[] = [
  { content: "Implement the feature", status: "complete" },
  { content: "Verify the behavior", status: "in_progress" },
  { content: "Polish the UI", status: "pending" },
];

test("creates a normalized active goal", () => {
  expect(goal("  Ship it  ")).toEqual({
    id: "goal-1",
    objective: "Ship it",
    status: "active",
    checks: [],
    tokenBudget: 1_000,
    tokensUsed: 0,
    timeUsedMs: 0,
    turns: 0,
    runTurns: 0,
    continuations: 0,
    noToolTurns: 0,
    createdAt: 100,
    updatedAt: 100,
  });
});

test("validates empty and oversized objectives", () => {
  expect(() => validateObjective("   ")).toThrow("must not be empty");
  expect(() => validateObjective("x".repeat(4_001))).toThrow("at most 4000");
  expect(validateObjective("x".repeat(4_000))).toHaveLength(4_000);
});

test("allows only one current progress check", () => {
  expect(validateGoalChecks(checks)).toEqual(checks);
  expect(() => validateGoalChecks([
    { content: "First", status: "in_progress" },
    { content: "Second", status: "in_progress" },
  ])).toThrow("Only one goal check");
});

test("reports structured progress and identifies the current check", () => {
  const updated = reportGoalProgress(goal(), checks, "Implementation is complete", 200);
  expect(updated.progressSummary).toBe("Implementation is complete");
  expect(goalCheckProgress(updated)).toEqual({ complete: 1, total: 3 });
  expect(currentGoalCheck(updated)?.content).toBe("Verify the behavior");
  expect(goalChecksComplete(updated)).toBe(false);
  expect(goalChecksComplete(reportGoalProgress(updated, checks.map((check) => ({ ...check, status: "complete" }))))).toBe(true);
});

test("tracks runs and continuation count separately", () => {
  const first = beginGoalRun(goal(), true, 200);
  const second = beginGoalRun(first, false, 300);
  expect(second.turns).toBe(2);
  expect(second.runTurns).toBe(2);
  expect(second.continuations).toBe(1);
});

test("stops an active goal when its token budget is reached", () => {
  const updated = accountGoalUsage(goal(), { tokens: 1_200, timeMs: 2_500 }, 200);
  expect(updated.status).toBe("budget_limited");
  expect(updated.tokensUsed).toBe(1_200);
  expect(updated.timeUsedMs).toBe(2_500);
});

test("late accounting preserves a terminal status", () => {
  const complete = setGoalStatus(goal(), "complete", 200);
  const accounted = accountGoalUsage(complete, { tokens: 50, timeMs: 1_000 }, 300);
  expect(accounted.status).toBe("complete");
  expect(accounted.tokensUsed).toBe(50);
});

test("blocks only after the same condition is reported in three runs", () => {
  const input = { description: "CI has no macOS capacity", evidence: "All jobs are queued", nextInput: "Wait for a runner" };
  const first = recordGoalBlocker(goal(), input, 1, 200);
  expect(first.blocked).toBe(false);
  expect(first.goal.blockerAudit?.count).toBe(1);

  const duplicate = recordGoalBlocker(first.goal, input, 1, 210);
  expect(duplicate.duplicate).toBe(true);
  expect(duplicate.goal.blockerAudit?.count).toBe(1);

  const second = recordGoalBlocker(first.goal, input, 2, 300);
  const third = recordGoalBlocker(second.goal, input, 3, 400);
  expect(third.goal.blockerAudit?.count).toBe(BLOCKED_AUDIT_TURNS);
  expect(third.blocked).toBe(true);
  expect(third.goal.status).toBe("blocked");
});

test("a different blocker or a productive run resets the blocker audit", () => {
  const first = recordGoalBlocker(goal(), { description: "Runner unavailable" }, 1).goal;
  const changed = recordGoalBlocker(first, { description: "Missing API decision" }, 2).goal;
  expect(changed.blockerAudit?.count).toBe(1);
  expect(clearGoalBlockerAudit(changed).blockerAudit).toBeUndefined();
});

test("editing a completed goal reactivates it but respects an exhausted budget", () => {
  const exhausted = setGoalStatus(accountGoalUsage(goal(), { tokens: 1_000 }), "complete");
  const edited = editGoalObjective(exhausted, "Ship the polished feature");
  expect(edited.objective).toBe("Ship the polished feature");
  expect(edited.status).toBe("budget_limited");
});

test("restores current and legacy versioned goal entries", () => {
  const current = { version: 2 as const, goal: goal() };
  expect(decodeGoalEntry(current)).toEqual({
    version: 2,
    goal: { ...goal(), progressSummary: undefined, blockerAudit: undefined },
  });
  expect(decodeGoalEntry({ version: 1, goal: goal() })?.version).toBe(2);
  expect(decodeGoalEntry({ version: 3, goal: goal() })).toBeUndefined();
  expect(decodeGoalEntry({ version: 2, goal: { objective: "broken" } })).toBeUndefined();
  expect(decodeGoalEntry({ version: 2, goal: null })).toEqual({ version: 2, goal: null });
});

test("formats elapsed time and tokens compactly", () => {
  expect(formatDuration(59_999)).toBe("59s");
  expect(formatDuration(90 * 60_000)).toBe("1h 30m");
  expect(formatDuration((24 * 60 + 2) * 60_000)).toBe("1d 0h 2m");
  expect(formatTokens(63_876)).toBe("63.9K");
  expect(formatTokens(1_250)).toBe("1.3K");
});
