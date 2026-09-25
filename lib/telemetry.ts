export type TelemetryStyle = "compact" | "full" | "hide";
export const TELEMETRY_ENTRY = "transcript-telemetry-state";
export const TELEMETRY_CHANGED = "transcript-telemetry:changed";
export const RESPONSE_TIMING_EVENT = "turn-stats:response";
export interface ResponseTimingSample { ttftMs: number; tps?: number }
export const isTelemetryStyle = (value: unknown): value is TelemetryStyle => value === "compact" || value === "full" || value === "hide";
export function telemetryStyle(entries: readonly any[]): TelemetryStyle {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === TELEMETRY_ENTRY && entry.data?.version === 1 && isTelemetryStyle(entry.data.style)) return entry.data.style;
  }
  return "compact";
}
