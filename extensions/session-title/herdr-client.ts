import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

export type HerdrMethod = "pane.get" | "tab.get" | "tab.rename";
export type HerdrRequest = (
  path: string,
  method: HerdrMethod,
  params: Record<string, string>,
  signal: AbortSignal,
) => Promise<unknown>;

/** One bounded JSON-line exchange; no shell, subscriptions, or background retries. */
export function herdrRequest(
  path: string,
  method: HerdrMethod,
  params: Record<string, string>,
  signal: AbortSignal,
  timeoutMs = 750,
): Promise<unknown> {
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection({ path });
    let buffer = "";
    let bytes = 0;
    let settled = false;
    const finish = (error?: string, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(new Error(error));
      else resolve(result);
    };
    const abort = () => finish("cancelled");
    const timer = setTimeout(() => finish("Herdr did not respond in time"), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) return finish("Herdr response exceeded the size limit");
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, end));
        if (reply?.id !== id) return finish("Herdr response ID did not match");
        if (reply.error) return finish("Herdr rejected the request; check its API version and pane");
        if (!reply.result || typeof reply.result !== "object") return finish("Unsupported Herdr response");
        finish(undefined, reply.result);
      } catch {
        finish("Malformed Herdr response");
      }
    });
    socket.once("error", () => finish("Herdr socket is unavailable"));
    socket.once("close", () => finish("Herdr closed the connection before replying"));
  });
}
