import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { expansionHint } from "../../lib/tool-ui.ts";
import { washLine } from "./diff.ts";

/** A neutral, inset command surface. Its shade is independent of execution state. */
export function commandPanel(highlighted: string, width: number, theme: Theme, expanded: boolean): string[] {
  if (width <= 0) return [];
  const margin = width >= 8 ? 2 : 0;
  const gutter = width >= 6 ? theme.fg("border", "│ ") : "";
  const gutterWidth = visibleWidth(gutter);
  const rightPadding = width >= 8 ? 1 : 0;
  const inner = Math.max(1, width - margin - gutterWidth - rightPadding);
  // A double-width glyph cannot occupy one cell. Keep the native word wrapper
  // on a safe canvas, then cell-clip only for exceptionally tiny terminals.
  const wrapped = wrapTextWithAnsi(highlighted, Math.max(2, inner));
  const limit = expanded ? 128 : 4;
  const background = theme.getBgAnsi?.("toolPendingBg") ?? "";
  const rows = wrapped.slice(0, limit).map((line) => {
    const text = gutter + truncateToWidth(line, inner, "");
    return " ".repeat(margin) + washLine(background, text, visibleWidth(text), width - margin);
  });
  if (wrapped.length > limit) {
    const indent = " ".repeat(Math.min(margin + gutterWidth, Math.max(0, width - 1)));
    const omitted = wrapped.length - limit;
    const notice = theme.fg("muted", `… ${omitted} more command ${omitted === 1 ? "line" : "lines"} · ${expansionHint()}`);
    rows.push(indent + truncateToWidth(notice, width - indent.length, ""));
  }
  return rows;
}
