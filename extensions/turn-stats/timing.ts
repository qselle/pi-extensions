export interface ResponseTiming {
  latencyMs: number; latencySamples: number;
  streamMs: number; outputTokens: number; streamSamples: number;
}
export const emptyTiming = (): ResponseTiming => ({ latencyMs: 0, latencySamples: 0, streamMs: 0, outputTokens: 0, streamSamples: 0 });

export function addTiming(total: ResponseTiming, sent: number | undefined, first: number | undefined, ended: number, output: unknown): void {
  if (sent === undefined || first === undefined || ![sent, first, ended].every(Number.isFinite) || first < sent || ended < first) return;
  total.latencyMs += first - sent;
  total.latencySamples++;
  const duration = ended - first;
  if (duration < 250 || typeof output !== "number" || !Number.isFinite(output) || output < 0) return;
  total.streamMs += duration;
  total.outputTokens += output;
  total.streamSamples++;
}

export function validTiming(value: ResponseTiming, responses: number): boolean {
  return value !== null && typeof value === "object"
    && [value.latencyMs, value.streamMs, value.outputTokens].every((n) => Number.isFinite(n) && n >= 0)
    && [value.latencySamples, value.streamSamples].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= responses)
    && value.streamSamples <= value.latencySamples
    && (value.latencySamples > 0 || value.latencyMs === 0)
    && (value.streamSamples > 0 ? value.streamMs >= 250 * value.streamSamples : value.streamMs === 0 && value.outputTokens === 0);
}

export function timingText(value: ResponseTiming | undefined, responses: number): string[] {
  const latency = value?.latencySamples ? `${Math.round(value.latencyMs / value.latencySamples)}ms` : "unknown";
  const rate = value?.streamSamples ? `${(value.outputTokens / (value.streamMs / 1000)).toFixed(1)} tokens/s` : "unknown";
  return [
    `Mean first-output latency: ${latency} · ${value?.latencySamples ?? 0}/${responses} responses measured`,
    `Aggregate streaming rate: ${rate} · ${value?.streamSamples ?? 0}/${responses} responses measured`,
  ];
}
