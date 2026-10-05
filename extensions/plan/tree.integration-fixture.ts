import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createPlanState, replacePlan } from "./plan.ts";
import { MAX_CARD_ROWS, PlanPanel, PlanToolResult, planOverlayTitle, renderPlanOverlayBody, renderPlanSummary, renderPlanText } from "./ui.ts";
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
    assert(rows.length <= Math.min(MAX_CARD_ROWS, height), "a large plan never exceeds the card cap");
    assert(rows.every((line) => visibleWidth(line) <= width));
    if (width >= 60) assert(rows.join("\n").includes("Verify 界 release 👩‍💻"), "the current step stays visible");
    assert(!rows.join("\n").includes("explanation"));
    assert(!rows.join("\n").includes("Task 0.0"), "finished groups stay collapsed");
    if (width >= 60 && height >= MAX_CARD_ROWS) {
      assert(rows.includes("✓ Group 0 10/10") && rows.includes("○ Group 2 0/10"), "other groups collapse to name n/m");
      assert(rows.includes("  ○ Task 1.9"), "the active group is expanded");
    }
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
const finishedLine = renderPlanSummary(complete, 80, theme);
assert(finishedLine.startsWith("Plan 1/1 · ✓ Complete") && finishedLine.endsWith("/plan") && visibleWidth(finishedLine) === 80);
assert.deepEqual(renderPlanOverlayBody(complete, 40, 5, theme), ["✓ Done"]);
assert(new PlanToolResult(complete, theme).render(80)[0]!.includes("Plan complete"));
assert(new PlanToolResult(createPlanState(), theme).render(80)[0]!.includes("Plan cleared"));

// Card snapshot at the default 50-column card (46 columns inside the frame).
const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
const tree = replacePlan(createPlanState(), [
  { step: "Research", children: [{ step: "Read docs", status: "completed" }, { step: "Survey code", status: "completed" }] },
  { step: "Build", children: [
    { step: "Implement API", status: "completed" },
    { step: "Wire the tree card", status: "in_progress", description: "Expand the active group, collapse the others, and keep the current step visible in short terminals." },
    { step: "Polish", status: "pending" },
  ] },
  { step: "Release", children: [{ step: "Changelog", status: "pending" }, { step: "Tag", status: "pending" }] },
  { step: "Announce", status: "pending" },
]);
assert.equal(planOverlayTitle(tree, theme), " Plan 3/8 ");
assert.deepEqual(plain(renderPlanOverlayBody(tree, 46, 12, theme)), [
  "✓ Research 2/2",
  "● Build 1/3",
  "  ✓ Implement API",
  "  ● Wire the tree card",
  "    Expand the active group, collapse the",
  "    others, and keep the current step visible…",
  "  ○ Polish",
  "○ Release 0/2",
  "○ Announce",
]);
assert.deepEqual(plain(renderPlanOverlayBody(tree, 46, 6, theme)), [
  "  ✓ Implement API",
  "  ● Wire the tree card",
  "    Expand the active group, collapse the",
  "    others, and keep the current step visible…",
  "  ○ Polish",
  "+4 more · /plan",
]);
assert.deepEqual(plain(renderPlanOverlayBody(tree, 46, 3, theme)), ["  ● Wire the tree card", "    Expand the active group, collapse the", "+6 more · /plan"]);
assert.deepEqual(plain(renderPlanOverlayBody(tree, 46, 1, theme)), ["  ● Wire the tree card"]);
for (const width of [1, 8, 20, 46, 80]) {
  for (const height of [1, 2, 4, 12]) {
    const rows = renderPlanOverlayBody(tree, width, height, theme);
    assert(rows.length <= height && rows.every((line) => visibleWidth(line) <= width));
    assert.deepEqual(renderPlanOverlayBody(tree, width, height, theme), rows, "rendering is deterministic");
  }
}
const nestedFocus = replacePlan(createPlanState(), [
  { step: "Ship", children: [{ step: "Backend", children: [{ step: "Migrate", status: "completed" }, { step: "Deploy", status: "in_progress" }] }, { step: "Frontend", children: [{ step: "Build UI", status: "pending" }] }] },
]);
assert.deepEqual(plain(renderPlanOverlayBody(nestedFocus, 46, 12, theme)), [
  "● Ship 1/3", "  ● Backend 1/2", "    ✓ Migrate", "    ● Deploy", "  ○ Frontend 0/1",
]);
console.log("nested plan navigation, collapse, active-step visibility and native widths verified");
