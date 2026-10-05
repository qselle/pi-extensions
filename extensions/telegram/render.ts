import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { PlainOutput } from "../../lib/output.ts";
import { expansionHint, fitToolRow } from "../../lib/tool-ui.ts";

export const COLLAPSED_NOTIFICATION_ROWS = 12;
export const EXPANDED_NOTIFICATION_ROWS = 400;

/**
 * The sent Markdown source under the tool headline, with any error below it.
 * Rows are cached per width so a settled result renders identically each frame.
 */
export function notificationResult(
  message: string,
  error: string | undefined,
  theme: Pick<Theme, "fg">,
  expanded: boolean,
) {
  const text = new PlainOutput().push(message).replace(/\t/gu, "  ").trimEnd();
  const lines = text ? text.split("\n") : [];
  let cache: { width: number; rows: string[] } | undefined;
  return {
    invalidate() { cache = undefined; },
    render(width: number): string[] {
      if (width <= 0) return [];
      if (cache?.width === width) return cache.rows;
      const indent = width >= 8 ? "  " : "";
      const gutter = width >= 6 ? "│ " : "";
      const inner = Math.max(2, width - indent.length - gutter.length);
      const limit = expanded ? EXPANDED_NOTIFICATION_ROWS : COLLAPSED_NOTIFICATION_ROWS;
      // The tool schema bounds the source to 16k characters, so wrapping it all is cheap.
      const wrapped = lines.flatMap((line) => line ? wrapTextWithAnsi(line, inner) : [""]);
      const rows = wrapped.slice(0, limit).map((line) =>
        fitToolRow(`${indent}${gutter ? theme.fg("border", gutter) : ""}${theme.fg("muted", line)}`, width));
      if (wrapped.length > limit) {
        const omitted = wrapped.length - limit;
        const notice = `… ${omitted} more ${omitted === 1 ? "line" : "lines"} · ${expanded ? "preview limit" : expansionHint()}`;
        rows.push(fitToolRow(`${indent}${theme.fg("muted", notice)}`, width));
      }
      if (error) {
        for (const line of wrapTextWithAnsi(error, Math.max(2, width - indent.length))) {
          rows.push(fitToolRow(`${indent}${theme.fg("error", line)}`, width));
        }
      }
      cache = { width, rows };
      return rows;
    },
  };
}
