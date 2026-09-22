import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createPlanState, replacePlan } from "./plan.ts";
import { PlanPanel, PlanToolResult, renderPlanOverlayBody, renderPlanSummary, renderPlanText } from "./ui.ts";
import { buildPlanContext } from "./prompts.ts";
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text, strikethrough: (text: string) => text } as any;
const plan = replacePlan(createPlanState(), [{ step: "Build", children: [{ step: "Implement", status: "completed" }, { step: "Current 界", status: "in_progress" }] }, { step: "Release", children: [{ step: "Publish", status: "pending" }] }]);
let renders = 0; let closed = false;
const panel = new PlanPanel(plan, theme, () => { closed = true; }, () => renders++, () => 24);
const text = () => panel.render(80).join("\n");
assert(text().includes("Current 界"));
assert(!text().includes("Publish"));
panel.handleInput("\x1b[D"); // leaf -> parent
panel.handleInput(" "); // collapse active group
assert(!text().includes("Current 界"));
panel.handleInput("\x1b[C"); // expand group
assert(text().includes("Current 界"));
assert(renders >= 3);
for (const width of [1, 2, 20, 80]) {
  assert(panel.render(width).every((line) => visibleWidth(line) <= width));
  assert(panel.render(width).length <= 19);
  assert(new PlanToolResult(plan, theme).render(width).every((line) => visibleWidth(line) <= width));
}
for (const height of [1, 2, 3, 5]) {
  const rows = renderPlanOverlayBody(plan, 80, height, theme);
  assert(rows.length <= height);
  assert(rows.join("\n").includes("Current 界"));
}
assert(buildPlanContext(plan).includes("  - [>] Current 界"));
assert(renderPlanText(plan).includes("Build (1/2)"));
const receipt = new PlanToolResult(plan, theme).render(80).join("\n");
assert.equal(new PlanToolResult(plan, theme).render(80).length, 1);
assert(receipt.includes("Current 界") && !receipt.includes("Publish"));
assert(new PlanToolResult(plan, theme, true).render(80).join("\n").includes("Publish"));
panel.handleInput("\x1b"); assert(closed);

const large = replacePlan(createPlanState(), Array.from({ length: 3 }, (_, group) => ({
  step: `Group ${group}`, children: Array.from({ length: 10 }, (_, step) => ({
    step: group === 1 && step === 5 ? "Verify 界 release 👩‍💻" : `Task ${group}.${step}`,
    status: group * 10 + step < 15 ? "completed" as const : group * 10 + step === 15 ? "in_progress" as const : "pending" as const,
  })),
})), "This explanation belongs in the full plan, not the passive display.");
for (const width of [0, 1, 2, 12, 24, 60, 80, 160]) {
  const summary = renderPlanSummary(large, width, theme);
  assert(visibleWidth(summary) <= width);
  assert(!summary.includes("\n"));
  if (width >= 60) assert(summary.includes("Verify 界 release 👩‍💻"));
  for (const height of [1, 2, 3, 10, 100]) {
    const rows = renderPlanOverlayBody(large, width, height, theme);
    assert(rows.length <= Math.min(3, height), "a large plan must not fill spare terminal rows");
    assert(rows.every((line) => visibleWidth(line) <= width));
    if (width >= 60) assert(rows[0]!.includes("Verify 界 release 👩‍💻"));
    assert(!rows.join("\n").includes("explanation"));
    assert(!rows.join("\n").includes("Task 0.0"));
  }
  const result = new PlanToolResult(large, theme).render(width);
  assert.equal(result.length, width ? 1 : 0);
  assert(result.every((line) => visibleWidth(line) <= width));
}
assert(new PlanToolResult(large, theme, true).render(80).join("\n").includes("Task 2.9"));
for (const terminalHeight of [1, 4, 8, 12, 30]) {
  let dismissed = false;
  const tiny = new PlanPanel(large, theme, () => { dismissed = true; }, () => {}, () => terminalHeight);
  const rows = tiny.render(60);
  assert(rows.length <= Math.max(1, Math.floor(terminalHeight * 0.8)));
  assert(rows.join("\n").includes("Verify 界 release 👩‍💻"));
  tiny.handleInput("q");
  assert(dismissed);
}
const cancelled = replacePlan(createPlanState(), [
  { step: "Done", status: "completed" }, { step: "Dropped", status: "cancelled" }, { step: "Current", status: "in_progress" },
]);
assert(renderPlanSummary(cancelled, 100, theme).includes("Plan 1/3 · 1 cancelled"));
const complete = replacePlan(createPlanState(), [{ step: "Done", status: "completed" }]);
assert.equal(renderPlanSummary(complete, 80, theme), "");
assert(new PlanToolResult(complete, theme).render(80)[0]!.includes("Plan complete"));
assert(new PlanToolResult(createPlanState(), theme).render(80)[0]!.includes("Plan cleared"));
console.log("nested plan navigation, collapse, active-step visibility and native widths verified");
