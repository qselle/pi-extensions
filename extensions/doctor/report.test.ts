import { expect, test } from "bun:test";
import { formatReport, type Finding } from "./checks.ts";
import { reportBlocks } from "./report.ts";

test("TUI and text reports put actionable findings first without changing probe order", () => {
  const findings: Finding[] = [
    { id: "runtime", status: "ok", label: "Runtime", detail: "Node.js available." },
    { id: "optional", status: "off", label: "Optional service", detail: "Disabled." },
    { id: "key", status: "warn", label: "Search key", detail: "No key configured.", fix: "Set the key in Pi's environment." },
    { id: "reader", status: "warn", label: "Page reader", detail: "Reader missing.", fix: "Install the reader." },
  ];
  const original = JSON.stringify(findings);
  const blocks = reportBlocks(findings);
  expect(blocks[0]).toMatchObject({ id: "overview", label: "2 items need attention", labelColor: "warning" });
  expect(blocks[0]!.body).toContain("2 warnings · 1 check passed · 1 inactive");
  expect(blocks.map((block) => block.id)).toEqual(["overview", "finding:key", "finding:reader", "finding:runtime", "finding:optional"]);
  expect(blocks[1]!.body).toContain("Fix: Set the key");
  expect(blocks.at(-1)!.labelColor).toBe("muted");
  const text = formatReport(findings);
  expect(text.indexOf("! Search key")).toBeLessThan(text.indexOf("✓ Runtime"));
  expect(text.indexOf("✓ Runtime")).toBeLessThan(text.indexOf("– Optional service"));
  expect(JSON.stringify(findings)).toBe(original);
});

test("inactive integrations remain distinct from failed checks", () => {
  const findings: Finding[] = [{ id: "optional", status: "off", label: "Optional service", detail: "Disabled." }];
  const overview = reportBlocks(findings)[0]!;
  expect(overview.label).toBe("local checks passed");
  expect(overview.body).toContain("0 warnings · 0 checks passed · 1 inactive");
  expect(overview.body).toContain("no commands executed");
});
