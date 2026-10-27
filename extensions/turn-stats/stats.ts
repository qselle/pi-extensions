import { formatDuration } from "../../lib/telemetry-format.ts";
import { formatCost, formatTokens } from "../footer/format.ts";
import { emptyTiming, timingText, validTiming, type ResponseTiming } from "./timing.ts";
export const FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
type Field = typeof FIELDS[number];
export interface Totals { known: number; missing: number }
export interface Summary {
  version: 1; durationMs: number; responses: number; tools: number; failedTools: number;
  /** Wall-clock time for display only; elapsed time always uses a monotonic clock. */
  endedAt?: number;
  outcome: "settled" | "interrupted" | "error";
  usage: Record<Field, Totals>;
  timing?: ResponseTiming;
  /** Usage records from tool results and compactions; they add usage but are not model responses. */
  extraUsage?: number;
  /** Responses whose zero recorded cost was replaced by the model's configured pricing. */
  estimated?: number;
}
/** Prices a response's usage from model rates; undefined keeps the recorded value. */
export type CostEstimate = (usage: any) => number | undefined;

/** Records that contributed usage fields; a field is unknown when it is missing from all of them. */
export function usageRecords(summary: Summary): number {
  return summary.responses + (summary.extraUsage ?? 0);
}
export function emptySummary(): Summary {
  return { version: 1, durationMs: 0, responses: 0, tools: 0, failedTools: 0, outcome: "settled", timing: emptyTiming(),
    usage: Object.fromEntries(FIELDS.map((key) => [key, { known: 0, missing: 0 }])) as Summary["usage"] };
}
function addUsage(summary: Summary, usage: any, estimate?: CostEstimate): void {
  for (const field of FIELDS) {
    let value = field === "cost" ? usage?.cost?.total : usage?.[field];
    if (field === "cost" && value === 0 && estimate) {
      const price = estimate(usage);
      if (price !== undefined) { value = price; summary.estimated = (summary.estimated ?? 0) + 1; }
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) summary.usage[field].known += value;
    else summary.usage[field].missing++;
  }
}
export function recordResponse(summary: Summary, message: { usage?: any; stopReason?: string }, estimate?: CostEstimate): void {
  summary.responses++;
  if (message.stopReason === "error") summary.outcome = "error";
  else if (message.stopReason === "aborted" && summary.outcome !== "error") summary.outcome = "interrupted";
  addUsage(summary, message.usage, estimate);
}
/** Tool-reported usage (nested model calls) and compaction summaries, matching the footer's totals. */
export function recordExtraUsage(summary: Summary, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  summary.extraUsage = (summary.extraUsage ?? 0) + 1;
  addUsage(summary, usage);
}
export function decodeSummary(value: unknown): Summary | undefined {
  const row = value as Summary | undefined;
  if (!row || row.version !== 1 || !["settled", "interrupted", "error"].includes(row.outcome)
    || !Number.isFinite(row.durationMs) || row.durationMs < 0
    || ![row.responses, row.tools, row.failedTools].every((n) => Number.isSafeInteger(n) && n >= 0)
    || row.failedTools > row.tools) return;
  if (row.endedAt !== undefined && (!Number.isFinite(row.endedAt) || row.endedAt < 0 || row.endedAt > 8.64e15)) return;
  if (row.timing !== undefined && !validTiming(row.timing, row.responses)) return;
  if (row.extraUsage !== undefined && !(Number.isSafeInteger(row.extraUsage) && row.extraUsage >= 0)) return;
  if (row.estimated !== undefined && !(Number.isSafeInteger(row.estimated) && row.estimated >= 0 && row.estimated <= row.responses)) return;
  const records = usageRecords(row);
  if (!FIELDS.every((key) => {
    const total = row.usage?.[key];
    return total && Number.isFinite(total.known) && total.known >= 0 && Number.isSafeInteger(total.missing) && total.missing >= 0 && total.missing <= records;
  })) return;
  return row;
}

interface LegacyTurnStats {
  startedAt?: unknown; endedAt?: unknown; elapsedMs?: unknown;
  averageTiming?: { responseCount?: unknown; averageTtftMs?: unknown; tokensPerSecond?: unknown };
  usage?: Partial<Record<Field, unknown>>;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Older sessions stored per-turn totals and average timing as `turn-stats` entries.
 * Convert them to a summary; tool counts and outcome were not recorded.
 */
export function decodeLegacySummary(value: unknown): Summary | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as LegacyTurnStats;
  const responses = row.averageTiming?.responseCount;
  if (!finite(row.elapsedMs) || !Number.isSafeInteger(responses) || !finite(responses) || !row.usage || typeof row.usage !== "object") return;
  const summary = emptySummary();
  summary.durationMs = row.elapsedMs;
  summary.responses = responses;
  if (finite(row.endedAt) && row.endedAt <= 8.64e15) summary.endedAt = row.endedAt;
  for (const field of FIELDS) {
    const amount = row.usage[field];
    if (finite(amount)) summary.usage[field].known = amount;
    else summary.usage[field].missing = responses;
  }
  const timing = summary.timing!;
  const ttft = row.averageTiming?.averageTtftMs;
  const tps = row.averageTiming?.tokensPerSecond;
  if (responses > 0 && finite(ttft)) {
    timing.latencySamples = responses;
    timing.latencyMs = ttft * responses;
    // Averages only: one synthetic second per response reproduces the stored rate.
    if (finite(tps)) {
      timing.streamSamples = responses;
      timing.streamMs = 1000 * responses;
      timing.outputTokens = tps * responses;
    }
  }
  return decodeSummary(summary);
}
export function summaryText(summary: Summary, expanded = false, inProgress = false): string {
  const partial = FIELDS.some((key) => summary.usage[key].missing > 0);
  const headline = `${inProgress ? "Turn in progress" : `Turn ${summary.outcome}`} · ${formatDuration(summary.durationMs / 1000)} · ${summary.responses} model response${summary.responses === 1 ? "" : "s"} · ${summary.tools} tool${summary.tools === 1 ? "" : "s"}${summary.failedTools ? ` (${summary.failedTools} failed)` : ""}${partial ? " · usage incomplete" : ""}`;
  const records = usageRecords(summary);
  const rows = FIELDS.map((key) => {
    const total = summary.usage[key];
    const amount = total.missing === records && records > 0 ? "unknown" : key === "cost" ? formatCost(total.known) : formatTokens(total.known);
    const label = { input: "in", output: "out", cacheRead: "cache read", cacheWrite: "cache write", cost: "Recorded cost" }[key];
    const unit = summary.extraUsage ? "usage record" : "response";
    const estimated = key === "cost" && summary.estimated ? ` · ${summary.estimated} response${summary.estimated === 1 ? "" : "s"} priced from model rates` : "";
    return `${label}: ${amount}${total.missing ? ` · missing for ${total.missing} ${unit}${total.missing === 1 ? "" : "s"}` : ""}${estimated}`;
  });
  return expanded ? `${headline}\n${rows.join("\n")}\n${timingText(summary.timing, summary.responses).join("\n")}\nElapsed time includes tool work and provider waits; streaming rate excludes tool work. Recorded cost is an estimate.` : headline;
}
