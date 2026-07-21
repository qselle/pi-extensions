import type { SideUsage } from "./types.ts";

export function emptySideUsage(): SideUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addSideUsage(left: SideUsage, right: SideUsage): SideUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cost: left.cost + right.cost,
  };
}

/** Normalize a provider `Usage` object (or a stored record) into `SideUsage`. */
export function normalizeSideUsage(value: unknown): SideUsage {
  const usage = (value ?? {}) as Record<string, unknown>;
  const cost = usage.cost as { total?: unknown } | number | undefined;
  return {
    input: nonNegative(usage.input),
    output: nonNegative(usage.output),
    cacheRead: nonNegative(usage.cacheRead),
    cacheWrite: nonNegative(usage.cacheWrite),
    cost: nonNegative(typeof cost === "object" && cost ? cost.total : cost),
  };
}

export function isEmptyUsage(usage: SideUsage): boolean {
  return !usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite && !usage.cost;
}

/** Compact footer/overlay string, e.g. `side ↑12k ↓850 R20k $0.0421`. */
export function formatSideUsage(total: SideUsage, label = "side"): string | undefined {
  if (isEmptyUsage(total)) return undefined;
  const parts = [
    total.input ? `↑${formatTokens(total.input)}` : "",
    total.output ? `↓${formatTokens(total.output)}` : "",
    total.cacheRead ? `R${formatTokens(total.cacheRead)}` : "",
    total.cacheWrite ? `W${formatTokens(total.cacheWrite)}` : "",
    total.cost ? `$${total.cost.toFixed(4)}` : "",
  ].filter(Boolean);
  return `${label} ${parts.join(" ")}`;
}

export function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
