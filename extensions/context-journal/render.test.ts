import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { boundaryDivider, boundaryLabel, journalCall, journalResult } from "./render.ts";

test("rollover divider names the cause, usage and staleness", () => {
  expect(boundaryLabel({ version: 1, reason: "automatic", percent: 91.24 })).toBe("Context reset — automatic at 91.2% — no summary");
  expect(boundaryLabel({ version: 1, reason: "agent" })).toBe("Context reset — requested by agent — no summary");
  expect(boundaryLabel({ version: 1, reason: "manual", stale: true })).toBe("Context reset — manual — stale notes — no summary");
  // Boundaries written before reasons were recorded still render.
  expect(boundaryLabel({ version: 1 } as any)).toBe("Context reset — no summary");
});

test("rollover divider fits every width with a single stable row", () => {
  const theme = { fg: (_color: string, text: string) => `\x1b[2m${text}\x1b[22m` } as any;
  const divider = boundaryDivider({ version: 1, reason: "automatic", percent: 91.2 }, theme);
  for (let width = 0; width <= 120; width++) {
    const lines = divider.render(width);
    expect(lines.length).toBe(width <= 2 ? 0 : 1);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width - 2);
    expect(divider.render(width)).toEqual(lines);
  }
  expect(visibleWidth(divider.render(80)[0]!)).toBe(78);
  expect(divider.render(80)[0]).toContain(" Context reset — automatic at 91.2% — no summary ");
});

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const rows = (component: { render(width: number): string[] }, width = 80) => component.render(width).map((row) => row.trimEnd());
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

test("journal tool headlines follow the partial, settled and failed states", () => {
  const args = { action: "write", key: "objective", text: "Ship it" };
  expect(rows(journalCall("context_notes", args, plainTheme, { isPartial: true, args }))).toEqual(["• Saving note objective"]);
  expect(rows(journalCall("context_notes", args, plainTheme, { args }))).toEqual(["• Saved note objective"]);
  expect(rows(journalCall("context_notes", args, plainTheme, { isError: true, args }))).toEqual(["• Notes failed objective"]);
  expect(rows(journalCall("context_history", {}, plainTheme, {}))).toEqual(["• Searched history recent messages"]);
  expect(rows(journalCall("context_rollover", {}, plainTheme, {}))).toEqual(["• Rollover requested"]);
});

test("journal results collapse to one summary row and expand to the full text", () => {
  const args = { action: "write", key: "objective", text: "Line one with secret\nLine two" };
  const collapsed = journalResult("context_notes", text("Session note saved."), { expanded: false, isPartial: false }, plainTheme, { args }, ["secret"]);
  expect(rows(collapsed)).toEqual([expect.stringMatching(/^  └ Line one with \[redacted\] · /)]);
  expect(collapsed.render(80)).toBe(collapsed.render(80));
  const expanded = journalResult("context_notes", text("Session note saved."), { expanded: true, isPartial: false }, plainTheme, { args }, ["secret"]);
  expect(rows(expanded)).toEqual(["  └ Line one with [redacted]", "    Line two"]);
  const history = { ...text("a · user\nneedle"), details: { count: 2, nextBefore: "a" } };
  expect(rows(journalResult("context_history", history, { expanded: false, isPartial: false }, plainTheme, {}))[0]).toStartWith("  └ 2 matches · older matches available");
  expect(rows(journalResult("context_history", { ...text("none"), details: { count: 0 } }, { expanded: true, isPartial: false }, plainTheme, {}))).toEqual(["  └ No matching messages"]);
  const budget = text(JSON.stringify({ tokens: 45000, contextWindow: 100000, percent: 45, budget: { phase: "normal", remaining: 45000 } }));
  expect(rows(journalResult("context_budget", budget, { expanded: false, isPartial: false }, plainTheme, {}))).toEqual(["  └ 45.0% used · 45,000 tokens left in working budget · normal"]);
  expect(rows(journalResult("context_notes", text("Session note saved."), { expanded: false, isPartial: false }, plainTheme, { args: { action: "delete", key: "x" } }))).toEqual([]);
  expect(rows(journalResult("context_notes", text("Unknown note key."), { expanded: false, isPartial: false }, plainTheme, { isError: true, args: { action: "read" } }))).toEqual(["  └ Unknown note key."]);
  expect(journalResult("context_history", text(""), { expanded: false, isPartial: true }, plainTheme, {}).render(80)).toEqual([]);
  for (let width = 1; width <= 40; width++) for (const row of collapsed.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
});
