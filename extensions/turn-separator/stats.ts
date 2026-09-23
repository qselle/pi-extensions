import { fitCells, formatCost, formatPercent, formatTokens } from "../footer/format.ts";

/** Human duration: 45s, 2m 4s, 1h 20m. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

export interface TurnStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Absent on older saved entries; new records distinguish missing usage from zero. */
  responses?: number;
  missing?: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "cost", number>>;
  /** Time to first token of the last finalized response. */
  ttftMs?: number;
  /** Output tokens per second for the last finalized response. */
  tps?: number;
}

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

export function emptyStats(): TurnStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** Adds one response's usage into the running totals for this work block. */
export function addUsage(stats: TurnStats, usage: UsageLike | undefined): TurnStats {
  const next = { ...stats, responses: (stats.responses ?? 0) + 1, missing: { ...stats.missing } };
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
    const value = field === "cost" ? usage?.cost?.total : usage?.[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) next[field] += value;
    else next.missing[field] = (next.missing[field] ?? 0) + 1;
  }
  return next;
}

/** Total prompt tokens processed: fresh, cache-read, and cache-written. */
export function promptTokens(stats: TurnStats): number {
  return stats.input + stats.cacheRead + stats.cacheWrite;
}

/** Share of prompt tokens served from cache, or undefined when there was no prompt. */
export function cacheHitRate(stats: TurnStats): number | undefined {
  if (["input", "cacheRead", "cacheWrite"].some((field) => (stats.missing?.[field as keyof NonNullable<TurnStats["missing"]>] ?? 0) > 0)) return undefined;
  const prompt = promptTokens(stats);
  return prompt > 0 ? (stats.cacheRead / prompt) * 100 : undefined;
}

export function hasStats(stats: TurnStats | undefined): boolean {
  if (!stats) return false;
  return (stats.responses ?? 0) > 0 || promptTokens(stats) > 0 || stats.output > 0 || stats.cost > 0
    || stats.ttftMs !== undefined || stats.tps !== undefined;
}

/** Throughput for one response; undefined when the sample is too small to trust. */
export function tokensPerSecond(outputTokens: unknown, firstTokenAt?: number, endedAt?: number): number | undefined {
  if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens < 0 || firstTokenAt === undefined || endedAt === undefined || !Number.isFinite(firstTokenAt) || !Number.isFinite(endedAt)) return undefined;
  const seconds = (endedAt - firstTokenAt) / 1000;
  if (seconds < 0.25) return undefined;
  const rate = outputTokens / seconds;
  return Number.isFinite(rate) && rate >= 0 ? rate : undefined;
}

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatRate(tps: number): string {
  return tps >= 10 ? `${Math.round(tps)}` : tps.toFixed(1);
}

interface LabelCell {
  text: string;
  /** 0 never drops; higher numbers are dropped first when the rule is narrow. */
  priority: number;
}

export type StatStyle = (color: "accent" | "muted" | "text" | "warning" | "dim", text: string) => string;

/**
 * Cells in the order they render. Duration is pinned; the rest drop from the
 * least informative fields to input/output and cost as the terminal narrows.
 */
export function statCells(seconds: number | undefined, stats: TurnStats | undefined, style: StatStyle = (_color, text) => text): LabelCell[] {
  const cells: LabelCell[] = [];
  if (seconds !== undefined && Number.isFinite(seconds) && seconds >= 0) cells.push({ text: style("accent", `Worked for ${seconds < 1 ? "<1s" : formatDuration(seconds)}`), priority: 0 });
  if (!stats) return cells;

  const display = (field: "input" | "output" | "cacheRead" | "cacheWrite" | "cost") => {
    const missing = stats.missing?.[field] ?? 0;
    if (missing && missing === stats.responses) return field === "cost" ? "$?" : "?";
    return `${missing ? "≥" : ""}${field === "cost" ? formatCost(stats[field]) : formatTokens(stats[field])}`;
  };
  const value = (text: string) => style(text.startsWith("≥") ? "warning" : text.includes("?") || text === "—" ? "muted" : "text", text);
  const field = (label: string, text: string) => `${style("muted", label)} ${value(text)}`;

  const tokens: string[] = [];
  if (stats.input > 0 || stats.responses) tokens.push(field("in", display("input")));
  if (stats.output > 0 || stats.responses) tokens.push(field("out", display("output")));
  if (tokens.length > 0) cells.push({ text: tokens.join(style("dim", " · ")), priority: 20 });
  if (stats.cost > 0 || stats.responses) cells.push({ text: value(display("cost")), priority: 10 });

  const hitRate = cacheHitRate(stats);
  const partialPrompt = ["input", "cacheRead", "cacheWrite"].some((field) => (stats.missing?.[field as keyof NonNullable<TurnStats["missing"]>] ?? 0) > 0);
  const hit = partialPrompt ? "?" : hitRate === undefined ? "—" : formatPercent(hitRate);
  if (promptTokens(stats) > 0 || partialPrompt) cells.push({ text: field("cache hit", hit), priority: 30 });
  if (stats.tps !== undefined) cells.push({ text: `${value(formatRate(stats.tps))} ${style("muted", "tokens/s")}`, priority: 40 });
  if (stats.ttftMs !== undefined) cells.push({ text: field("first token", formatLatency(stats.ttftMs)), priority: 50 });
  if (stats.responses) cells.push({ text: `${value(String(stats.responses))} ${style("muted", stats.responses === 1 ? "reply" : "replies")}`, priority: 60 });
  if (stats.cacheRead > 0 || stats.missing?.cacheRead) cells.push({ text: field("cache read", display("cacheRead")), priority: 70 });
  if (stats.cacheWrite > 0 || stats.missing?.cacheWrite) cells.push({ text: field("cache write", display("cacheWrite")), priority: 70 });
  return cells;
}

/**
 * Assembles the rule label, dropping low-priority cells until it fits. Returns an
 * empty string when nothing fits, so the caller falls back to a bare rule.
 */
export function statsLabel(
  seconds: number | undefined,
  stats: TurnStats | undefined,
  maxWidth: number,
  widthOf: (value: string) => number = (value) => [...value].length,
  style: StatStyle = (_color, text) => text,
): string {
  const cells = statCells(seconds, stats, style);
  if (cells.length === 0 || maxWidth <= 0) return "";
  const kept = fitCells(cells, maxWidth, 3, widthOf);
  const text = kept.map((cell) => cell.text).join(style("dim", " · "));
  return widthOf(text) <= maxWidth ? text : "";
}
