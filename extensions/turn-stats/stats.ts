import { formatDuration } from "../turn-separator/stats.ts";
import { formatCost, formatTokens } from "../footer/format.ts";
import { emptyTiming, timingText, validTiming, type ResponseTiming } from "./timing.ts";
export const FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
type Field = typeof FIELDS[number];
export interface Totals { known: number; missing: number }
export interface Summary {
  version: 1; durationMs: number; responses: number; tools: number; failedTools: number;
  outcome: "settled" | "interrupted" | "error";
  usage: Record<Field, Totals>;
  timing?: ResponseTiming;
}
export function emptySummary(): Summary {
  return { version: 1, durationMs: 0, responses: 0, tools: 0, failedTools: 0, outcome: "settled", timing: emptyTiming(),
    usage: Object.fromEntries(FIELDS.map((key) => [key, { known: 0, missing: 0 }])) as Summary["usage"] };
}
export function recordResponse(summary: Summary, message: { usage?: any; stopReason?: string }): void {
  summary.responses++;
  if (message.stopReason === "error") summary.outcome = "error";
  else if (message.stopReason === "aborted" && summary.outcome !== "error") summary.outcome = "interrupted";
  for (const field of FIELDS) {
    const value = field === "cost" ? message.usage?.cost?.total : message.usage?.[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) summary.usage[field].known += value;
    else summary.usage[field].missing++;
  }
}
export function decodeSummary(value: unknown): Summary | undefined {
  const row = value as Summary | undefined;
  if (!row || row.version !== 1 || !["settled", "interrupted", "error"].includes(row.outcome)
    || !Number.isFinite(row.durationMs) || row.durationMs < 0
    || ![row.responses, row.tools, row.failedTools].every((n) => Number.isSafeInteger(n) && n >= 0)
    || row.failedTools > row.tools) return;
  if (row.timing !== undefined && !validTiming(row.timing, row.responses)) return;
  if (!FIELDS.every((key) => {
    const total = row.usage?.[key];
    return total && Number.isFinite(total.known) && total.known >= 0 && Number.isSafeInteger(total.missing) && total.missing >= 0 && total.missing <= row.responses;
  })) return;
  return row;
}
export function summaryText(summary: Summary, expanded = false, inProgress = false): string {
  const partial = FIELDS.some((key) => summary.usage[key].missing > 0);
  const headline = `${inProgress ? "Turn in progress" : `Turn ${summary.outcome}`} · ${formatDuration(summary.durationMs / 1000)} · ${summary.responses} response${summary.responses === 1 ? "" : "s"} · ${summary.tools} tool${summary.tools === 1 ? "" : "s"}${summary.failedTools ? ` (${summary.failedTools} failed)` : ""}${partial ? " · usage incomplete" : ""}`;
  const rows = FIELDS.map((key) => {
    const total = summary.usage[key];
    const amount = total.missing === summary.responses && summary.responses > 0 ? "unknown" : key === "cost" ? formatCost(total.known) : formatTokens(total.known);
    return `${key === "cost" ? "Recorded cost" : key}: ${amount}${total.missing ? ` · missing for ${total.missing} responses` : ""}`;
  });
  return expanded ? `${headline}\n${rows.join("\n")}\n${timingText(summary.timing, summary.responses).join("\n")}\nElapsed time includes tool work and provider waits; streaming rate excludes tool work. Recorded cost is an estimate.` : headline;
}
