import type { Theme } from "@earendil-works/pi-coding-agent";
import { expansionHint, fitToolRow } from "../../lib/tool-ui.ts";
import { toolPurpose } from "../../lib/tool-purpose.ts";
import { plain, type Action, type Args } from "./service.ts";

type Palette = Pick<Theme, "fg">;
interface RenderContext { args?: Partial<Args>; isPartial?: boolean; isError?: boolean }
interface Details { action?: Action; paneId?: string; label?: string }

const VERBS: Record<Action, [running: string, settled: string]> = {
  start: ["Starting", "Started"], list: ["Listing", "Listed"], read: ["Reading", "Read"],
  status: ["Inspecting", "Inspected"], input: ["Sending input", "Sent input"], interrupt: ["Interrupting", "Interrupted"],
};
/** Collapsed read/status/list cards show this many output rows. */
export const COLLAPSED_ROWS = 8;

/** Static rows fitted to the width; rebuilt only when the width changes. */
function rows(lines: string[]) {
  let width = -1;
  let fitted: string[] = [];
  return {
    invalidate() { width = -1; },
    render(next: number) {
      if (next !== width) { width = next; fitted = next > 0 ? lines.map((line) => fitToolRow(line, next)) : []; }
      return fitted.slice();
    },
  };
}

const oneLine = (text: unknown) => typeof text === "string" ? plain(text).replace(/\s+/g, " ").trim() : "";
const isAction = (value: unknown): value is Action => typeof value === "string" && Object.hasOwn(VERBS, value);

function headline(action: unknown, purpose: string, settled: boolean, failed: boolean, theme: Palette): string {
  const verbs = isAction(action) ? VERBS[action] : undefined;
  const verb = failed ? `${isAction(action) ? action[0]!.toUpperCase() + action.slice(1) : "Terminal process"} failed`
    : verbs?.[settled ? 1 : 0] ?? (settled ? "Used terminal process" : "Using terminal process");
  const bullet = theme.fg(!settled ? "accent" : failed ? "error" : "success", "•");
  return `${bullet} ${theme.fg("toolTitle", verb)}${purpose ? theme.fg("dim", " · ") + theme.fg("text", purpose) : ""}`;
}

/** The pane a call acts on: the label (and pane once known) for start, the pane otherwise. */
function target(action: unknown, args: Partial<Args>, details?: Details): string {
  if (action === "start") {
    const label = oneLine(details?.label ?? args.label);
    const pane = oneLine(details?.paneId);
    return [label, pane].filter(Boolean).join(" · ");
  }
  return action && action !== "list" ? oneLine(details?.paneId ?? args.pane_id) : "";
}

/** Running headline with its target; the settled result row replaces it. */
export function renderCall(args: Partial<Args> | undefined, theme: Palette, context?: RenderContext) {
  if (!context?.isPartial) return rows([]);
  const input = args ?? {};
  const where = target(input.action, input);
  return rows([headline(input.action, toolPurpose(input.purpose), false, false, theme), ...(where ? [`  └ ${theme.fg("dim", where)}`] : [])]);
}

/** Settled headline with a success or error bullet, its target, and output for reads and failures. */
export function renderResult(result: { content?: { type: string; text?: string }[]; details?: unknown }, options: { expanded: boolean; isPartial: boolean }, theme: Palette, context?: RenderContext) {
  if (options.isPartial) return rows([]);
  const args = context?.args ?? {};
  const details = result.details as Details | undefined;
  const action = args.action ?? details?.action;
  const failed = !!context?.isError;
  const lines = [headline(action, toolPurpose(args.purpose), true, failed, theme)];
  const where = target(action, args, details);
  if (where) lines.push(`  └ ${theme.fg("dim", where)}`);
  // Input results never echo text; start and interrupt say nothing beyond the headline.
  if (failed || action === "read" || action === "status" || action === "list") {
    const text = plain((result.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")).replace(/\n+$/, "");
    const output = text ? text.split("\n") : [];
    const shown = options.expanded ? output : output.slice(0, COLLAPSED_ROWS);
    lines.push(...shown.map((line) => `    ${theme.fg(failed ? "error" : "toolOutput", line)}`));
    if (shown.length < output.length) lines.push(`    ${theme.fg("dim", `… ${output.length - shown.length} more lines · ${expansionHint()}`)}`);
  }
  return rows(lines);
}
