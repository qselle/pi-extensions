import type { Fetch } from "./client.ts";

/** Backoff for HTTP 429 (and keyless 502/503/504), with up to 500 ms of jitter per step. */
export const RATE_LIMIT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000] as const;
const JITTER_MS = 500;

export interface RetryPolicy {
  /** `performance.now()` time after which no retry may start. */
  deadline: number;
  /** Retry HTTP 429. Off when a paid fallback should take over instead. */
  rateLimit: boolean;
  /** Also retry 502/503/504 (hosted keyless access only). */
  serverErrors?: boolean;
}

function retryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(header.trim())) return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : Number.NaN;
}

async function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Request cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener("abort", abort, { once: true });
  });
  signal?.throwIfAborted();
}

/**
 * Retry explicit rejections with backoff, honoring Retry-After, only while the wait fits the
 * remaining deadline. Network failures are never replayed: the request may have been received.
 */
export async function requestWithRetry(request: Fetch, url: string, init: RequestInit, policy: RetryPolicy): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await request(url, init);
    const retryable = (policy.rateLimit && response.status === 429) || (policy.serverErrors && [502, 503, 504].includes(response.status));
    if (!retryable || attempt >= RATE_LIMIT_DELAYS_MS.length) return response;
    const delay = retryAfter(response.headers.get("retry-after")) ?? RATE_LIMIT_DELAYS_MS[attempt]! + Math.floor(Math.random() * (JITTER_MS + 1));
    // A cooldown longer than the remaining deadline is surfaced instead of blocking the tool.
    if (!Number.isFinite(delay) || delay >= policy.deadline - performance.now()) return response;
    await response.body?.cancel();
    await sleep(delay, init.signal);
  }
}
