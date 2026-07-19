import { expect, test } from "bun:test";
import { createGoalCompletedEvent } from "../goal/events.ts";
import { createGoal, reportGoalProgress, setGoalStatus } from "../goal/goal.ts";
import { formatGoalCompletionMessage, TELEGRAM_MESSAGE_LIMIT } from "./message.ts";

function completion(objective = "Ship Telegram notifications") {
  let goal = createGoal(objective, { id: "goal", now: 1 });
  goal = reportGoalProgress(goal, [
    { content: "Implement transport", status: "complete" },
    { content: "Remove obsolete behavior", status: "cancelled" },
  ], "Verified delivery and secret handling", 2);
  goal = setGoalStatus({ ...goal, tokensUsed: 12_500, timeUsedMs: 125_000, turns: 4 }, "complete", 3);
  return createGoalCompletedEvent(goal, "completion", 3);
}

test("formats minimal, summary, and full goal notifications", () => {
  const event = completion();
  expect(formatGoalCompletionMessage(event, "minimal")).toBe("✅ Pi goal completed");

  const summary = formatGoalCompletionMessage(event, "summary");
  expect(summary).toContain("Objective:\nShip Telegram notifications");
  expect(summary).toContain("Progress: 2/2 checks");
  expect(summary).toContain("Tokens: 13k");
  expect(summary).toContain("Elapsed: 2m 5s");
  expect(summary).toContain("Turns: 4");
  expect(summary).toContain("Verified delivery and secret handling");
  expect(summary).not.toContain("Implement transport");

  const full = formatGoalCompletionMessage(event, "full");
  expect(full).toContain("Checks:\n✓ Implement transport\n– Remove obsolete behavior");
});

test("sanitizes controls and stays below Telegram's safe message limit", () => {
  const event = completion(`${"Long objective ".repeat(250)}\u0000done`);
  const message = formatGoalCompletionMessage(event, "full");
  expect(Array.from(message).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
  expect(message.endsWith("…")).toBe(true);
  expect(message).not.toContain("\u0000");
});
