import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";
import { PlainOutput } from "../../lib/output.ts";
import { fitToolRow } from "../../lib/tool-ui.ts";

/** Safety bound only: the tool schema limits the source to 16k characters. */
export const MAX_NOTIFICATION_ROWS = 400;

/**
 * The sent message, rendered as Markdown the way Telegram formats it, under the tool headline,
 * with any error below it. The whole message shows without expansion: it is short, and the user
 * wants to read exactly what was sent. Rows are cached per width so a settled result renders
 * identically each frame.
 */
export function notificationResult(
  message: string,
  error: string | undefined,
  theme: Pick<Theme, "fg">,
  /** Ignored: the full message shows collapsed and expanded alike. */
  _expanded = false,
  markdownTheme?: MarkdownTheme,
) {
  const text = new PlainOutput().push(message).replace(/\t/gu, "  ").trim();
  let cache: { width: number; rows: string[] } | undefined;
  return {
    invalidate() { cache = undefined; },
    render(width: number): string[] {
      if (width <= 0) return [];
      if (cache?.width === width) return cache.rows;
      const indent = width >= 8 ? "  " : "";
      const gutter = width >= 6 ? "│ " : "";
      const inner = Math.max(2, width - indent.length - gutter.length);
      // Muted body text reads as quoted content, quieter than the assistant's prose.
      const style = { color: (value: string) => theme.fg("muted", value) };
      // Markdown pads rows to the full width; drop the padding so short lines leave no trailing blanks.
      const formatted = text ? new Markdown(text, 0, 0, markdownTheme ?? getMarkdownTheme(), style).render(inner).map((row) => row.replace(/ +$/u, "")) : [];
      const rows = formatted.slice(0, MAX_NOTIFICATION_ROWS).map((line) =>
        fitToolRow(`${indent}${gutter ? theme.fg("border", gutter) : ""}${line}`, width));
      if (formatted.length > MAX_NOTIFICATION_ROWS) {
        const omitted = formatted.length - MAX_NOTIFICATION_ROWS;
        rows.push(fitToolRow(`${indent}${theme.fg("muted", `… ${omitted} more ${omitted === 1 ? "line" : "lines"} · preview limit`)}`, width));
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
