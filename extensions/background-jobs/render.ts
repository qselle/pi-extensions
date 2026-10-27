import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { elapsed } from "../working-status/state.ts";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
type RenderOptions = { expanded: boolean; isPartial: boolean };
type Palette = Pick<Theme, "fg">;

/** Collapsed job cards show this many output rows below their status headline. */
export const COLLAPSED_TAIL_ROWS = 4;
const EXPANDED_ROWS = 200;
const FAILED = new Set(["failed", "timed-out", "interrupted"]);

/** Static rows fitted to the width; rebuilt only when the width changes. */
export function lines(text: string) {
  const rows = text.split("\n");
  let width = -1;
  let fitted: string[] = [];
  return {
    invalidate() { width = -1; },
    render(next: number) {
      if (next !== width) { width = next; fitted = next > 0 ? rows.map((row) => truncateToWidth(row, next, "…")) : []; }
      return fitted.slice();
    },
  };
}

/** One-row call headline: status bullet, action, and optional purpose. */
export function headline(title: string, purpose: string, theme: Palette, context?: Partial<ToolRenderContext>) {
  const bullet = context?.isError ? "error" : context?.executionStarted && context?.isPartial ? "accent" : "muted";
  return lines(theme.fg(bullet, "•") + " " + theme.fg("toolTitle", title) + (purpose ? theme.fg("dim", " · ") + theme.fg("text", purpose) : ""));
}

const gutter = (rows: string[]) => rows.map((row, index) => (index === 0 ? "  └ " : "    ") + row);
const textOf = (value: any): string => value?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "";

/** Status headline plus a short output tail under a gutter; expanded shows the full result. */
export function renderJobResult(value: any, options: RenderOptions, theme: Palette, context?: Partial<ToolRenderContext>) {
  if (options.isPartial && !value?.content?.length) return lines(gutter([theme.fg("muted", "Waiting for job…")]).join("\n"));
  const text = textOf(value);
  const split = text.indexOf("\n\n");
  const header = (split >= 0 ? text.slice(0, split) : text).split("\n");
  const body = split >= 0 ? text.slice(split + 2).replace(/\n+$/, "").split("\n") : [];
  const failed = context?.isError || FAILED.has(value?.details?.status);
  const rows = [theme.fg(failed ? "error" : "muted", header[0] || "Job result") + waitEnd(value?.details?.wait, theme)];
  const extra = options.expanded ? header.slice(1) : header.slice(1).filter((row) => row.startsWith("Still running"));
  rows.push(...extra.map((row) => theme.fg("dim", row)));
  const limit = options.expanded ? EXPANDED_ROWS : COLLAPSED_TAIL_ROWS;
  const hidden = Math.max(0, body.length - limit);
  if (hidden) rows.push(theme.fg("dim", `… ${hidden} earlier lines${options.expanded ? "" : " · expand to view"}`));
  rows.push(...body.slice(hidden).map((row) => theme.fg("toolOutput", row)));
  return lines(gutter(rows).join("\n"));
}

/** Why a wait ended early, from the result's own timestamps so settled rows never change. */
function waitEnd(wait: any, theme: Palette): string {
  if (wait?.end !== "interrupted" && wait?.end !== "message") return "";
  const waited = elapsed(Number(wait.observedAt) - Number(wait.startedAt));
  return wait.end === "interrupted" ? theme.fg("warning", ` · interrupted after ${waited}`) : theme.fg("dim", ` · new message after ${waited}`);
}

/** Job list: one counted headline and one row per job. */
export function renderJobList(value: any, options: RenderOptions, theme: Palette) {
  const jobs: { id: string; name: string; status: string; icon?: string }[] = Array.isArray(value?.details?.jobs) ? value.details.jobs : [];
  if (!jobs.length) return lines(gutter([theme.fg("muted", textOf(value) || "No managed jobs in this session.")]).join("\n"));
  const active = jobs.filter((job) => ["starting", "running", "stopping"].includes(job.status)).length;
  const limit = options.expanded ? jobs.length : COLLAPSED_TAIL_ROWS;
  const rows = [theme.fg("muted", `${jobs.length} job${jobs.length === 1 ? "" : "s"} · ${active} active`),
    ...jobs.slice(0, limit).map((job) => theme.fg(FAILED.has(job.status) ? "error" : "toolOutput", `${job.icon ?? "·"} ${job.name} · ${job.status} · ${job.id}`))];
  if (jobs.length > limit) rows.push(theme.fg("dim", `… ${jobs.length - limit} more · expand to view`));
  return lines(gutter(rows).join("\n"));
}
