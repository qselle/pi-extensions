import { expect, test } from "bun:test";
import { createGoal, reportGoalProgress, stallGoal } from "./goal.ts";
import { buildBudgetLimitMessage, buildContinuationPrompt, buildGoalContext, buildReconciliationMessage, goalResponse } from "./prompts.ts";

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

test("wraps objective and checks as escaped user-priority task data without live counters", () => {
  const goal = budgetedGoal();
  const context = buildGoalContext(goal);
  expect(context).toContain("## Persistent goal");
  expect(context).toContain("<goal_objective>\nFix &lt;main&gt; &amp; verify\n</goal_objective>");
  expect(context).toContain("[x] Implement &lt;main&gt;");
  expect(context).toContain("[>] Run tests &amp; inspect output");
  expect(context).toContain("Latest progress: Implementation is ready");
  expect(context).not.toContain("750");
  // Usage, timing, runs and blocker audits change without a transition.
  expect(buildGoalContext({ ...goal, tokensUsed: 1_900, timeUsedMs: 1, turns: 9, continuations: 4, noToolTurns: 2 })).toBe(context);
  expect(buildGoalContext({ ...goal, status: "complete" })).toBe(buildGoalContext(undefined));
});

test("reports structured progress, usage, and remaining budget", () => {
  expect(JSON.parse(goalResponse(budgetedGoal()))).toEqual({
    goal: {
      id: "goal-1",
      objective: "Fix <main> & verify",
      status: "active",
      request_id: null,
      reconciliation: null,
      checks: [
        { content: "Implement <main>", status: "complete" },
        { content: "Run tests & inspect output", status: "in_progress" },
      ],
      progress: { complete: 1, total: 2, cancelled: 0 },
      progressSummary: "Implementation is ready",
      stallReason: null,
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
  expect(JSON.parse(goalResponse(budgetedGoal(), "request-1")).goal.request_id).toBe("request-1");
});

test("escalates after an empty continuation instead of accepting another blank response", () => {
  expect(buildContinuationPrompt(budgetedGoal())).not.toContain("previous continuation");
  const context = buildContinuationPrompt({ ...budgetedGoal(), noToolTurns: 1 });
  expect(context).toContain("previous continuation ended without a tool call");
  expect(context).toContain("Do not return an empty or status-only response");
});

test("keeps a stalled goal visible with a safe recovery path", () => {
  const context = buildGoalContext(stallGoal(budgetedGoal(), "Agent run failed: WebSocket error"));
  expect(context).toContain("State: stalled");
  expect(context).toContain("Resume only when the user explicitly asks");
  expect(context).toContain("Stop reason: Agent run failed: WebSocket error");
  expect(context).toContain("call resume_goal with goal_id and the request_id from get_goal, then reconcile_goal");
  expect(context).toContain("A progress report never resumes a goal");
});

test("pending goal context gives the current request precedence and keeps status questions in scope", () => {
  const context = buildReconciliationMessage({ ...budgetedGoal(), reconciliation: { requestId: "new-request", requestedAt: 12 } });
  expect(context).toContain("request_id: new-request");
  expect(context).toContain("latest user request outranks older goal text");
  expect(context).toContain("including status questions");
  expect(context).toContain("complete objective and checks");
  expect(context).toContain("only when the user explicitly asks to pause");
  expect(context).toContain("terminal updates wait for reconciliation");
});

test("budget-limit steering prevents new substantive work", () => {
  const message = buildBudgetLimitMessage({ ...budgetedGoal(), tokensUsed: 2_100, status: "budget_limited" });
  expect(message).toContain("2.1K / 2K");
  expect(message).toContain("Do not begin new substantive work");
});
