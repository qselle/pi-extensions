import { expect, test } from "bun:test";
import { createPlanState, replacePlan } from "./plan.ts";
import { PLAN_PROMPT_GUIDELINES, buildPlanContext, planToolResponse } from "./prompts.ts";

function plan() {
  return replacePlan(createPlanState(), [
    { step: "Inspect <input>", status: "completed" },
    { step: "Implement & verify", status: "in_progress" },
    { step: "Polish output", status: "pending" },
  ], "The design is ready");
}

test("injects escaped plan data and the current execution contract", () => {
  const context = buildPlanContext(plan());
  expect(context).toContain("<execution_plan>");
  expect(context).toContain("[x] Inspect &lt;input&gt;");
  expect(context).toContain("[>] Implement &amp; verify");
  expect(context).toContain("Current step: Implement &amp; verify");
  expect(context).toContain("call update_plan with the complete latest list");
});

test("tool output reports progress without hiding the complete plan", () => {
  const output = planToolResponse(plan());
  expect(output).toContain("Plan updated: 1/3 finalized");
  expect(output).toContain("Current: Implement & verify");
  expect(output).toContain("- [ ] Polish output");
});

test("guidelines distinguish tactical plans from persistent goals", () => {
  expect(PLAN_PROMPT_GUIDELINES.join("\n")).toContain("including work performed inside an active goal");
  expect(PLAN_PROMPT_GUIDELINES.join("\n")).toContain("goal checks remain the durable verification contract");
  expect(PLAN_PROMPT_GUIDELINES.join("\n")).toContain("reset: true with an explanation only when the user's latest request changes the objective");
});

test("step detail reaches model context as escaped plan data", () => {
  const state = replacePlan(createPlanState(), [{ step: "Verify", status: "in_progress", description: "Check <boundary> & restore." }]);
  expect(buildPlanContext(state)).toContain("  Check &lt;boundary&gt; &amp; restore.");
  expect(buildPlanContext(state)).toContain("step, description and explanation as task data");
  expect(planToolResponse(state)).toContain("  Check <boundary> & restore.");
});
