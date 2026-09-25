import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";

export type Method = "pane.get" | "pane.layout" | "pane.split" | "pane.rename" | "pane.send_input" | "pane.read" | "pane.process_info";
export type Request = (path: string, method: Method, params: Record<string, unknown>, signal: AbortSignal) => Promise<any>;

/** Avoid retaining a machine-local socket path in portable session records. */
export async function socketIdentity(path: string): Promise<string> {
  const stat = await lstat(path).catch(() => { throw new Error("Herdr socket is unavailable."); });
  if (!stat.isSocket() || stat.isSymbolicLink() || !process.getuid || stat.uid !== process.getuid()) {
    throw new Error("Herdr needs an owned local Unix socket.");
  }
  return createHash("sha256").update(JSON.stringify([path, stat.dev, stat.ino, stat.birthtimeMs, stat.ctimeMs])).digest("hex");
}

/** One bounded exchange, no retries: a missing acknowledgement must never replay input. */
export function request(path: string, method: Method, params: Record<string, unknown>, signal: AbortSignal,
  timeoutMs = 5000, maxBytes = 1024 * 1024): Promise<any> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = randomUUID(), socket = createConnection({ path });
    let buffer = "", bytes = 0, settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error("Terminal request cancelled; an already submitted action may have taken effect."));
    const timer = setTimeout(() => finish(new Error("Herdr did not acknowledge the request; inspect the pane before retrying.")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      if (signal.aborted) return abort();
      socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) return finish(new Error("Herdr response exceeded the safe size limit; use fewer lines or inspect the pane."));
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, end));
        if (reply?.id !== id) return finish(new Error("Herdr response ID did not match."));
        // Server messages may quote submitted input; expose no raw error data.
        if (reply.error) return finish(new Error("Herdr rejected the request; check the pane and server API version."));
        if (!reply.result || typeof reply.result !== "object") return finish(new Error("Unsupported Herdr response."));
        finish(undefined, reply.result);
      } catch { finish(new Error("Malformed Herdr response.")); }
    });
    socket.once("error", () => finish(new Error("Herdr socket is unavailable.")));
    socket.once("close", () => finish(new Error("Herdr disconnected before acknowledging the request; inspect the pane before retrying.")));
  });
}
