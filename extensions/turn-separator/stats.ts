/**
 * Pure per-turn statistics for the separator rule: accumulation, derived values,
 * and width-aware label assembly. No pi/tui imports, so it is unit-testable.
 *
 * Number formatting and the priority-drop layout are reused from the footer, so
 * a token count or cost reads identically in both places.
 */

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

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Adds one response's usage into the running totals for this work block. */
export function addUsage(stats: TurnStats, usage: UsageLike | undefined): TurnStats {
  if (!usage) return stats;
  return {
    ...stats,
    input: stats.input + positive(usage.input),
    output: stats.output + positive(usage.output),
    cacheRead: stats.cacheRead + positive(usage.cacheRead),
    cacheWrite: stats.cacheWrite + positive(usage.cacheWrite),
    cost: stats.cost + positive(usage.cost?.total),
  };
}

/** Total prompt tokens processed: fresh, cache-read, and cache-written. */
export function promptTokens(stats: TurnStats): number {
  return stats.input + stats.cacheRead + stats.cacheWrite;
}

/** Share of prompt tokens served from cache, or undefined when there was no prompt. */
export function cacheHitRate(stats: TurnStats): number | undefined {
  const prompt = promptTokens(stats);
  return prompt > 0 ? (stats.cacheRead / prompt) * 100 : undefined;
}

export function hasStats(stats: TurnStats | undefined): boolean {
  if (!stats) return false;
  return promptTokens(stats) > 0 || stats.output > 0 || stats.cost > 0
    || stats.ttftMs !== undefined || stats.tps !== undefined;
}

/** Throughput for one response; undefined when the sample is too small to trust. */
export function tokensPerSecond(outputTokens: number, firstTokenAt?: number, endedAt?: number): number | undefined {
  if (!outputTokens || firstTokenAt === undefined || endedAt === undefined) return undefined;
  const seconds = (endedAt - firstTokenAt) / 1000;
  if (seconds < 0.25) return undefined;
  const rate = outputTokens / seconds;
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
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

/**
 * Cells in the order they render. Duration is pinned; the rest drop from the
 * least informative (ttft) to the most (cost) as the terminal narrows.
 */
export function statCells(seconds: number | undefined, stats: TurnStats | undefined): LabelCell[] {
  const cells: LabelCell[] = [];
  if (seconds !== undefined && seconds >= 1) cells.push({ text: `Worked for ${formatDuration(seconds)}`, priority: 0 });
  if (!stats) return cells;

  const tokens: string[] = [];
  const prompt = promptTokens(stats);
  if (prompt > 0) tokens.push(`↓${formatTokens(prompt)}`);
  if (stats.output > 0) tokens.push(`↑${formatTokens(stats.output)}`);
  if (tokens.length > 0) cells.push({ text: tokens.join(" "), priority: 2 });

  // Cache writes cost ~12x a read, so a write-heavy turn is the expensive one and
  // is surfaced with the same priority as cost rather than being dropped early.
  const hitRate = cacheHitRate(stats);
  if (stats.cacheWrite > 0 && stats.cacheRead > 0) {
    cells.push({ text: `cache ${formatPercent(hitRate)} +${formatTokens(stats.cacheWrite)}`, priority: 3 });
  } else if (stats.cacheWrite > 0) {
    cells.push({ text: `cache write ${formatTokens(stats.cacheWrite)}`, priority: 1 });
  } else if (stats.cacheRead > 0) {
    cells.push({ text: `cache ${formatPercent(hitRate)}`, priority: 3 });
  }

  if (stats.tps !== undefined) cells.push({ text: `${formatRate(stats.tps)} tps`, priority: 4 });
  if (stats.ttftMs !== undefined) cells.push({ text: `ttft ${formatLatency(stats.ttftMs)}`, priority: 5 });
  if (stats.cost > 0) cells.push({ text: formatCost(stats.cost), priority: 1 });
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
): string {
  const cells = statCells(seconds, stats);
  if (cells.length === 0 || maxWidth <= 0) return "";
  const kept = fitCells(cells, maxWidth, 3, widthOf);
  const text = kept.map((cell) => cell.text).join(" · ");
  return widthOf(text) <= maxWidth ? text : "";
}
