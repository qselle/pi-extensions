import { setGoalStatus, validateGoalChecks, validateObjective, type GoalCheck, type GoalState } from "./goal.ts";

export const RECONCILIATION_STALL_REASON = "The latest user request still needs goal reconciliation. Use /goal resume to continue this objective, or /goal edit or clear to change it.";

export function requireGoalReconciliation(goal: GoalState, requestId: string = crypto.randomUUID(), now = Date.now()): GoalState {
  return { ...goal, reconciliation: { requestId, requestedAt: now }, updatedAt: now };
}

export function assertGoalIdentity(goal: GoalState | undefined, goalId: string): asserts goal is GoalState {
  if (!goal || goal.id !== goalId) throw new Error("The goal changed. Read get_goal before using goal controls.");
}

export function assertGoalReconciled(goal: GoalState): void {
  if (goal.reconciliation) throw new Error("Reconcile the latest user request with reconcile_goal before updating goal progress or final status.");
}

export function assertGoalRequest(goal: GoalState, requestId: string): void {
  if (!goal.reconciliation || goal.reconciliation.requestId !== requestId) {
    throw new Error("The user request changed. Read get_goal and reconcile its current request_id.");
  }
}

export function reconcileGoal(
  goal: GoalState,
  requestId: string,
  action: "keep" | "revise" | "pause",
  revision: { objective?: string; checks?: GoalCheck[] } = {},
  now = Date.now(),
): GoalState {
  assertGoalRequest(goal, requestId);
  if (action !== "keep" && action !== "revise" && action !== "pause") throw new Error("Unknown reconciliation action.");
  let next = goal;
  if (action === "revise") {
    if (typeof revision.objective !== "string" || !Array.isArray(revision.checks)) {
      throw new Error("Revising requires the complete objective and complete checks list; use [] when no checks are needed.");
    }
    next = {
      ...goal,
      objective: validateObjective(revision.objective),
      checks: validateGoalChecks(revision.checks),
      progressSummary: undefined,
      blockerAudit: undefined,
      noToolTurns: 0,
    };
  } else if (revision.objective !== undefined || revision.checks !== undefined) {
    throw new Error("Objective and checks may be changed only with action revise.");
  }
  if (action === "pause") next = setGoalStatus(next, "paused", now);
  return {
    ...next,
    reconciliation: undefined,
    stallReason: next.stallReason === RECONCILIATION_STALL_REASON ? undefined : next.stallReason,
    updatedAt: now,
  };
}

export function resumeGoalForRequest(goal: GoalState, now = Date.now()): GoalState {
  if (goal.status === "active") throw new Error("The goal is already active. Reconcile a pending request instead.");
  if (goal.status === "complete") throw new Error("The goal is complete; create a new goal only for an explicit new request.");
  if (goal.status === "budget_limited" || goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
    throw new Error("The goal's token budget is exhausted and cannot be changed by resuming.");
  }
  const resumed = setGoalStatus(goal, "active", now);
  return goal.reconciliation ? resumed : requireGoalReconciliation(resumed, undefined, now);
}
