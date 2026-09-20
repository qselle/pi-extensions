import type { Fetch } from "./client.ts";

/** Retry one explicit rejection, within the original request deadline. Never replay network failures. */
export async function requestWithRetry(request: Fetch, url: string, init: RequestInit, keyless: boolean): Promise<Response> {
  const response = await request(url, init);
  const retryable = response.status === 429 || (keyless && [502, 503, 504].includes(response.status));
  if (!retryable) return response;
  const header = response.headers.get("retry-after");
  const milliseconds = header === null ? 250 : /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  // Long cooldowns should be surfaced to the caller instead of blocking the tool.
  if (!Number.isFinite(milliseconds) || milliseconds > 2000) return response;
  await response.body?.cancel();
  const signal = init.signal;
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Request cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, Math.max(0, milliseconds));
    signal?.addEventListener("abort", abort, { once: true });
  });
  signal?.throwIfAborted();
  return request(url, init);
}
