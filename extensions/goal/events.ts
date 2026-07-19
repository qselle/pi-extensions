import type { GoalState } from "./goal.ts";

export const GOAL_COMPLETED_EVENT = "goal:completed";

export interface GoalCompletedEvent {
  readonly version: 1;
  readonly completionId: string;
  readonly completedAt: number;
  readonly goal: Readonly<GoalState>;
}

export function createGoalCompletedEvent(
  goal: GoalState,
  completionId: string,
  completedAt: number,
): GoalCompletedEvent {
  if (goal.status !== "complete") throw new Error("A goal completion event requires a completed goal.");
  if (!completionId.trim()) throw new Error("A goal completion event requires a completion ID.");
  if (!Number.isFinite(completedAt) || completedAt <= 0) throw new Error("A goal completion event requires a valid timestamp.");
  return deepFreeze({
    version: 1 as const,
    completionId,
    completedAt,
    goal: structuredClone(goal),
  });
}

export function isGoalCompletedEvent(value: unknown): value is GoalCompletedEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GoalCompletedEvent>;
  const goal = candidate.goal;
  return candidate.version === 1
    && typeof candidate.completionId === "string"
    && candidate.completionId.trim().length > 0
    && typeof candidate.completedAt === "number"
    && Number.isFinite(candidate.completedAt)
    && candidate.completedAt > 0
    && Boolean(goal)
    && typeof goal?.id === "string"
    && goal.id.length > 0
    && typeof goal.objective === "string"
    && goal.status === "complete"
    && Array.isArray(goal.checks)
    && goal.checks.every((check) => Boolean(
      check
      && typeof check.content === "string"
      && (check.status === "complete" || check.status === "cancelled"),
    ))
    && isNonNegativeFinite(goal.tokensUsed)
    && isNonNegativeFinite(goal.timeUsedMs)
    && isNonNegativeFinite(goal.turns)
    && (goal.progressSummary === undefined || typeof goal.progressSummary === "string");
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
