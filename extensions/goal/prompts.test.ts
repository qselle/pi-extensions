import { expect, test } from "bun:test";
import { createGoal, reportGoalProgress } from "./goal.ts";
import { buildBudgetLimitMessage, buildGoalContext, goalResponse } from "./prompts.ts";

function budgetedGoal() {
  const goal = createGoal("Fix <main> & verify", { id: "goal-1", now: 0, tokenBudget: 2_000 });
  return {
    ...reportGoalProgress(goal, [
      { content: "Implement <main>", status: "complete" },
      { content: "Run tests & inspect output", status: "in_progress" },
    ], "Implementation is ready"),
    tokensUsed: 750,
    timeUsedMs: 90_000,
  };
}

test("wraps objective and checks as escaped user-priority task data", () => {
  const context = buildGoalContext(budgetedGoal(), true);
  expect(context).toContain("Persistent goal continuation");
  expect(context).toContain("<goal_objective>\nFix &lt;main&gt; &amp; verify\n</goal_objective>");
  expect(context).toContain("[x] Implement &lt;main&gt;");
  expect(context).toContain("[>] Run tests &amp; inspect output");
  expect(context).toContain("750 / 2K tokens");
  expect(context).toContain("update_goal");
});

test("reports structured progress, usage, and remaining budget", () => {
  expect(JSON.parse(goalResponse(budgetedGoal()))).toEqual({
    goal: {
      objective: "Fix <main> & verify",
      status: "active",
      checks: [
        { content: "Implement <main>", status: "complete" },
        { content: "Run tests & inspect output", status: "in_progress" },
      ],
      progress: { complete: 1, total: 2 },
      progressSummary: "Implementation is ready",
      blocker: null,
      tokenBudget: 2_000,
      tokensUsed: 750,
      remainingTokens: 1_250,
      timeUsedSeconds: 90,
      turns: 0,
      continuations: 0,
    },
  });
  expect(JSON.parse(goalResponse(undefined))).toEqual({ goal: null });
});

test("budget-limit steering prevents new substantive work", () => {
  const message = buildBudgetLimitMessage({ ...budgetedGoal(), tokensUsed: 2_100, status: "budget_limited" });
  expect(message).toContain("2.1K / 2K");
  expect(message).toContain("Do not begin new substantive work");
});
