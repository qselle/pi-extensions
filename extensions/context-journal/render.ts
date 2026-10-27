import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { PlainOutput } from "../../lib/output.ts";
import { redactText } from "../../lib/redact.ts";
import { expansionHint, fitToolRow, toolHeadline } from "../../lib/tool-ui.ts";
import { knownSecretValues } from "../questions/secrets.ts";

export type RolloverReason = "manual" | "agent" | "automatic";
export interface BoundaryData { version: 1; reason?: RolloverReason; percent?: number; stale?: boolean }

export function boundaryLabel(data: Partial<BoundaryData> | undefined): string {
  const percent = typeof data?.percent === "number" && Number.isFinite(data.percent) ? ` at ${data.percent.toFixed(1)}%` : "";
  const cause = data?.reason === "manual" ? "manual" : data?.reason === "agent" ? "requested by agent" : data?.reason === "automatic" ? `automatic${percent}` : "";
  return ["Context reset", cause, data?.stale ? "stale notes" : "", "no summary"].filter(Boolean).join(" — ");
}

/** A dim centered rule; two spare columns keep styled full-width rows from wrapping. */
export function boundaryDivider(data: Partial<BoundaryData> | undefined, theme: Pick<Theme, "fg">): Component {
  const label = boundaryLabel(data);
  return {
    invalidate() {},
    render(width: number): string[] {
      const usable = Math.max(0, Math.floor(width) - 2);
      if (!usable) return [];
      const text = ` ${label} `;
      if (visibleWidth(text) + 2 > usable) return [theme.fg("dim", truncateToWidth(label, usable, "…"))];
      const fill = usable - visibleWidth(text);
      const left = Math.floor(fill / 2);
      return [theme.fg("dim", `${"─".repeat(left)}${text}${"─".repeat(fill - left)}`)];
    },
  };
}

export type JournalTool = "context_notes" | "context_history" | "context_budget" | "context_rollover";
interface RenderContext { isPartial?: boolean; isError?: boolean; args?: any }
interface ToolResult { content: readonly { type: string; text?: string }[]; details?: any }
const EXPANDED_ROWS = 400;
const EMPTY: Component = { invalidate() {}, render: () => [] };
const plain = (value: unknown) => new PlainOutput().push(typeof value === "string" ? value : "").replace(/\t/g, "  ");
const oneLine = (value: unknown, max = 160) => plain(value).replace(/\s+/g, " ").trim().slice(0, max);
const resultText = (result: ToolResult) => result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();

/**
 * A compact tool body: one muted summary row, or the full text when expanded.
 * Inputs are captured once and rows are cached per width, so settled cards repaint identically.
 */
export function resultBody(summary: string, full: string | undefined, theme: Pick<Theme, "fg">, expanded: boolean, error = false): Component {
  const text = full === undefined ? undefined : plain(full).trimEnd();
  const short = oneLine(summary);
  const expandable = !!text && text !== short;
  let cache: { width: number; rows: string[] } | undefined;
  return {
    invalidate() { cache = undefined; },
    render(width: number): string[] {
      if (width <= 0) return [];
      if (cache?.width === width) return cache.rows;
      const color = error ? "error" : "muted";
      const inner = Math.max(1, width - 4);
      let rows: string[];
      if (expanded && expandable) {
        const wrapped = text!.split("\n").flatMap((line) => line ? wrapTextWithAnsi(line, inner) : [""]);
        rows = wrapped.slice(0, EXPANDED_ROWS).map((line, index) => fitToolRow(`${theme.fg("dim", index ? "    " : "  └ ")}${theme.fg(color, line)}`, width));
        if (wrapped.length > EXPANDED_ROWS) rows.push(fitToolRow(`    ${theme.fg("dim", `… ${wrapped.length - EXPANDED_ROWS} more lines · preview limit`)}`, width));
      } else {
        const hint = expandable ? ` · ${expansionHint()}` : "";
        const room = inner - visibleWidth(hint);
        const shown = hint && room >= 12 ? truncateToWidth(short, room, "…") : short;
        rows = [fitToolRow(`${theme.fg("dim", "  └ ")}${theme.fg(color, shown)}${hint && room >= 12 ? theme.fg("dim", hint) : ""}`, width)];
      }
      cache = { width, rows };
      return rows;
    },
  };
}

const CALL_LABELS: Record<string, [partial: string, done: string]> = {
  list: ["Listing notes", "Listed notes"], read: ["Reading note", "Read note"], write: ["Saving note", "Saved note"], delete: ["Deleting note", "Deleted note"],
};
export function journalCall(tool: JournalTool, args: any, theme: Theme, context?: RenderContext): Component {
  const pick = ([partial, done]: [string, string], failed: string) => context?.isError ? failed : context?.isPartial ? partial : done;
  if (tool === "context_notes") return toolHeadline(pick(CALL_LABELS[args?.action] ?? ["Using notes", "Used notes"], "Notes failed"), oneLine(args?.key, 64), theme, context?.isError);
  if (tool === "context_history") return toolHeadline(pick(["Searching history", "Searched history"], "History search failed"), oneLine(args?.query, 160) || "recent messages", theme, context?.isError);
  if (tool === "context_budget") return toolHeadline(pick(["Checking context budget", "Context budget"], "Budget check failed"), "", theme, context?.isError);
  return toolHeadline(pick(["Requesting rollover", "Rollover requested"], "Rollover refused"), "", theme, context?.isError);
}

function budgetSummary(text: string): string {
  try {
    const usage = JSON.parse(text);
    const percent = typeof usage.percent === "number" ? `${usage.percent.toFixed(1)}% used` : "";
    const left = typeof usage.budget?.remaining === "number" ? `${usage.budget.remaining.toLocaleString("en-US")} tokens left in working budget` : "";
    return [percent, left, usage.budget?.phase].filter(Boolean).join(" · ");
  } catch { return text; }
}
export function journalResult(tool: JournalTool, result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context?: RenderContext, secrets: readonly string[] = []): Component {
  if (options.isPartial) return EMPTY;
  const text = resultText(result);
  if (context?.isError) return resultBody(text.split("\n")[0] ?? "", text, theme, options.expanded, true);
  if (tool === "context_notes") {
    const action = context?.args?.action;
    if (action === "write") { const note = redactText(plain(context?.args?.text), secrets); return resultBody(note.split("\n")[0] ?? "", note, theme, options.expanded); }
    if (action === "read") return resultBody(text.split("\n")[0] ?? "", text, theme, options.expanded);
    if (action === "list") {
      const keys = text.startsWith("No ") ? [] : text.split("\n").map((line) => line.split(" · ")[0]);
      return resultBody(keys.length ? `${keys.length} ${keys.length === 1 ? "note" : "notes"}: ${keys.join(", ")}` : text, text, theme, options.expanded);
    }
    return EMPTY;
  }
  if (tool === "context_history") {
    const count = Number(result.details?.count) || 0;
    return resultBody(count ? `${count} ${count === 1 ? "match" : "matches"}${result.details?.nextBefore ? " · older matches available" : ""}` : "No matching messages", count ? text : undefined, theme, options.expanded);
  }
  if (tool === "context_budget") return resultBody(budgetSummary(text), undefined, theme, options.expanded);
  return EMPTY;
}

/** Compact cards shared by every journal tool. */
export const journalRenderers = (tool: JournalTool) => ({
  renderShell: "self" as const,
  renderCall: (args: any, theme: Theme, context: RenderContext) => journalCall(tool, args, theme, context),
  renderResult: (result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: RenderContext) => journalResult(tool, result, options, theme, context, knownSecretValues()),
});
