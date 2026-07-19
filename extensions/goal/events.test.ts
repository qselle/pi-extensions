import { expect, test } from "bun:test";
import { createGoal } from "./goal.ts";
import { createGoalCompletedEvent, isGoalCompletedEvent } from "./events.ts";

test("creates an immutable versioned completion snapshot", () => {
  const source = { ...createGoal("Ship notifications", { id: "goal-1", now: 1 }), status: "complete" as const };
  const event = createGoalCompletedEvent(source, "completion-1", 2);
  source.objective = "mutated source";

  expect(event).toMatchObject({
    version: 1,
    completionId: "completion-1",
    completedAt: 2,
    goal: { id: "goal-1", objective: "Ship notifications", status: "complete" },
  });
  expect(Object.isFrozen(event)).toBe(true);
  expect(Object.isFrozen(event.goal)).toBe(true);
  expect(Object.isFrozen(event.goal.checks)).toBe(true);
  expect(isGoalCompletedEvent(event)).toBe(true);
  expect(isGoalCompletedEvent({ ...event, version: 2 })).toBe(false);
  expect(isGoalCompletedEvent({
    version: 1,
    completionId: "incomplete-payload",
    completedAt: 2,
    goal: { id: "goal", status: "complete" },
  })).toBe(false);
});

test("rejects invalid completion event inputs", () => {
  const active = createGoal("Still active", { now: 1 });
  expect(() => createGoalCompletedEvent(active, "completion", 2)).toThrow("completed goal");
  expect(() => createGoalCompletedEvent({ ...active, status: "complete" }, "", 2)).toThrow("completion ID");
  expect(() => createGoalCompletedEvent({ ...active, status: "complete" }, "completion", 0)).toThrow("valid timestamp");
});
