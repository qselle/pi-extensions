import { expect, test } from "bun:test";
import { COLLAPSED_ROWS, renderCall, renderResult } from "./render.ts";

const theme = { fg: (color: string, text: string) => color === "accent" || color === "success" || color === "error" ? `<${color}>${text}` : text };
const text = (value: string) => ({ content: [{ type: "text", text: value }] });
const settled = { expanded: false, isPartial: false };

test("running calls show a present-tense verb and their target; settled calls leave the row to the result", () => {
  const args = { action: "start" as const, purpose: "Serve the frontend", command: "bun run dev", label: "frontend" };
  expect(renderCall(args, theme, { isPartial: true }).render(80)).toEqual(["<accent>• Starting · Serve the frontend", "  └ frontend"]);
  expect(renderCall({ action: "read", pane_id: "w1:p2" }, theme, { isPartial: true }).render(80)).toEqual(["<accent>• Reading", "  └ w1:p2"]);
  expect(renderCall({}, theme, { isPartial: true }).render(80)).toEqual(["<accent>• Using terminal process"]);
  expect(renderCall(args, theme, { isPartial: false }).render(80)).toEqual([]);
});

test("results show a success or error bullet, the target with its pane, and output only for reads and failures", () => {
  const args = { action: "start" as const, purpose: "Serve the frontend", label: "frontend" };
  const started = renderResult({ ...text("Command submitted in frontend (w1:p2)."), details: { action: "start", paneId: "w1:p2", label: "frontend" } }, settled, theme, { args });
  expect(started.render(80)).toEqual(["<success>• Started · Serve the frontend", "  └ frontend · w1:p2"]);
  const input = renderResult({ ...text("Input sent to w1:p2."), details: { action: "input", paneId: "w1:p2" } }, settled, theme, { args: { action: "input", text: "secret" } });
  expect(input.render(80)).toEqual(["<success>• Sent input", "  └ w1:p2"]);
  const failed = renderResult(text("Pane identity changed."), settled, theme, { args: { action: "interrupt", pane_id: "w1:p2" }, isError: true });
  expect(failed.render(80)).toEqual(["<error>• Interrupt failed", "  └ w1:p2", "    <error>Pane identity changed."]);
  const output = Array.from({ length: 12 }, (_, index) => `line-${index}`).join("\n");
  const read = renderResult({ ...text(output), details: { action: "read", paneId: "w1:p2" } }, settled, theme, { args: { action: "read", pane_id: "w1:p2" } }).render(80);
  expect(read.slice(0, 3)).toEqual(["<success>• Read", "  └ w1:p2", "    line-0"]);
  expect(read).toHaveLength(2 + COLLAPSED_ROWS + 1);
  expect(read.at(-1)).toStartWith("    … 4 more lines · ");
  const expanded = renderResult({ ...text(output), details: { action: "read" } }, { expanded: true, isPartial: false }, theme, {}).render(80);
  expect(expanded.at(-1)).toBe("    line-11");
  expect(renderResult(text("partial"), { expanded: false, isPartial: true }, theme, {}).render(80)).toEqual([]);
});
