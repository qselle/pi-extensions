import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createPlanState, replacePlan } from "./plan.ts";
import { PlanPanel, PlanToolResult, renderPlanOverlayBody, renderPlanText } from "./ui.ts";
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
assert(receipt.includes("Current 界") && !receipt.includes("Publish"));
assert(new PlanToolResult(plan, theme, true).render(80).join("\n").includes("Publish"));
panel.handleInput("\x1b"); assert(closed);
console.log("nested plan navigation, collapse, active-step visibility and native widths verified");
