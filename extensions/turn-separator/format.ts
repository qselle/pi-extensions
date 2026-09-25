import { formatDuration, formatLatency, formatRate } from "../../lib/telemetry-format.ts";
export { formatDuration } from "../../lib/telemetry-format.ts";

export interface StepTiming { ttftMs?: number; tps?: number }

/** Quiet, wrap-safe step rule. Usage totals appear only in the final receipt. */
export function separatorText(
  seconds: number | undefined,
  width: number,
  timing?: StepTiming,
  dim: (text: string) => string = (text) => text,
  widthOf: (value: string) => number = (value) => [...value].length,
): string {
  if (!Number.isFinite(width) || width < 1) return "";
  const usable = Math.max(0, Math.floor(width) - 2);
  if (!usable) return "";
  let left = seconds !== undefined && Number.isFinite(seconds) && seconds >= 60 ? `─ Worked for ${formatDuration(seconds)} ` : "";
  const bits: string[] = [];
  if (timing?.ttftMs !== undefined && Number.isFinite(timing.ttftMs) && timing.ttftMs >= 0) bits.push(`first token ${formatLatency(timing.ttftMs)}`);
  if (timing?.tps !== undefined && Number.isFinite(timing.tps) && timing.tps >= 0) bits.push(`${formatRate(timing.tps)} tokens/s`);
  while (bits.length && widthOf(` ${bits.join(" · ")} ─`) + 1 > usable) bits.shift();
  const right = bits.length ? ` ${bits.join(" · ")} ─` : "";
  if (widthOf(left + right) + 1 > usable) left = "";
  return dim(left + "─".repeat(usable - widthOf(left + right)) + right);
}
