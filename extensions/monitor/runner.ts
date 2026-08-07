import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { MonitorObservation } from "./monitor.ts";

export const MAX_CAPTURE_BYTES = 10_000;
const FORCE_KILL_DELAY_MS = 5_000;

export function runBoundedProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<MonitorObservation> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = new BoundedCapture();
    const stderr = new BoundedCapture();
    let killed = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal?.removeEventListener("abort", terminate);
    };
    const terminate = () => {
      if (settled || killed) return;
      killed = true;
      killProcessTree(child, "SIGTERM");
      forceKill = setTimeout(() => {
        if (!settled) killProcessTree(child, "SIGKILL");
      }, FORCE_KILL_DELAY_MS);
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      const capturedStdout = stdout.finish();
      const capturedStderr = stderr.finish();
      resolve({
        code: code ?? (killed ? 143 : 1),
        killed,
        stdout: capturedStdout.text,
        stderr: capturedStderr.text,
        stdoutDigest: capturedStdout.digest,
        stderrDigest: capturedStderr.digest,
        stdoutTruncated: capturedStdout.truncated,
        stderrTruncated: capturedStderr.truncated,
      });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", finish);

    if (signal?.aborted) terminate();
    else signal?.addEventListener("abort", terminate, { once: true });
    if (timeoutMs > 0) timeout = setTimeout(terminate, timeoutMs);
  });
}

class BoundedCapture {
  private readonly hash = createHash("sha256");
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;

  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.hash.update(buffer);
    this.totalBytes += buffer.length;
    const remaining = MAX_CAPTURE_BYTES - this.retainedBytes;
    if (remaining <= 0) return;
    const retained = buffer.subarray(0, remaining);
    this.chunks.push(retained);
    this.retainedBytes += retained.length;
  }

  finish(): { text: string; digest: string; truncated: boolean } {
    const text = Buffer.concat(this.chunks).toString("utf8");
    const omitted = this.totalBytes - this.retainedBytes;
    return {
      text: omitted > 0 ? `${text}\n… ${omitted.toLocaleString()} bytes omitted` : text,
      digest: this.hash.digest("hex"),
      truncated: omitted > 0,
    };
  }
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => undefined);
    killer.unref();
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch { child.kill(signal); }
}
