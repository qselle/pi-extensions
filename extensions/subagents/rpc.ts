import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";

const REQUEST_TIMEOUT_MS = 30_000;
const TERMINATE_GRACE_MS = 1_000;
const KILL_GRACE_MS = 1_000;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const CHILD_MARKER = "PI_SUBAGENT_CHILD";

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface AgentClient {
  readonly pid?: number;
  start(): Promise<void>;
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: RpcEvent) => void): () => void;
  onExit(listener: (error: Error) => void): () => void;
  stderr(): string;
}

export interface AgentClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
}

export type AgentClientFactory = (options: AgentClientOptions) => AgentClient;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const liveProcessGroups = new Set<number>();
let reaperInstalled = false;

export function getPiCommand(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const executable = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

export function subagentEnvironment(id: string): Record<string, string> {
  return { [CHILD_MARKER]: "1", PI_SUBAGENT_PARENT_ID: id };
}

export function isSubagentProcess(): boolean {
  return process.env[CHILD_MARKER] === "1";
}

export class RpcAgentClient implements AgentClient {
  private child?: ChildProcessWithoutNullStreams;
  private stopReader?: () => void;
  private readonly events = new Set<(event: RpcEvent) => void>();
  private readonly exits = new Set<(error: Error) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private requestSequence = 0;
  private stderrTail = "";
  private terminalError?: Error;
  private stopping = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: AgentClientOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("Subagent RPC client already started");
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child = child;
    if (child.pid) {
      liveProcessGroups.add(child.pid);
      installExitReaper();
    }

    child.stderr.on("data", (chunk) => {
      this.stderrTail = boundedTail(this.stderrTail, String(chunk), MAX_STDERR_BYTES);
    });
    child.stdin.on("error", (error) => this.fail(new Error(`Subagent stdin failed: ${error.message}`)));
    child.once("error", (error) => this.fail(new Error(`Subagent process failed: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (child.pid) liveProcessGroups.delete(child.pid);
      this.fail(new Error(
        `Subagent process exited (code=${code ?? "none"}, signal=${signal ?? "none"})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`,
      ));
    });
    this.stopReader = readJsonLines(
      child.stdout,
      (line) => this.handleLine(line),
      (error) => {
        this.fail(error);
        void this.stop().catch(() => undefined);
      },
    );

    try {
      await this.request({ type: "get_state" });
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  prompt(message: string): Promise<void> {
    return this.request({ type: "prompt", message }).then(() => undefined);
  }

  steer(message: string): Promise<void> {
    return this.request({ type: "steer", message }).then(() => undefined);
  }

  abort(): Promise<void> {
    return this.request({ type: "abort" }).then(() => undefined);
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }

  stderr(): string {
    return this.stderrTail;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.stopReader?.();
    this.stopReader = undefined;

    let closed = child.exitCode !== null || child.signalCode !== null;
    if (!closed) {
      const waiting = waitForClose(child, TERMINATE_GRACE_MS);
      killProcessTree(child.pid, "SIGTERM");
      closed = await waiting;
    }
    if (!closed) {
      const waiting = waitForClose(child, KILL_GRACE_MS);
      killProcessTree(child.pid, "SIGKILL");
      closed = await waiting;
    }
    if (!closed) throw new Error(`Subagent process ${child.pid ?? "unknown"} did not exit after SIGKILL`);

    if (child.pid) liveProcessGroups.delete(child.pid);
    this.child = undefined;
    this.rejectPending(new Error("Subagent RPC client stopped"));
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.type === "extension_ui_request") {
      this.cancelDialog(message);
      return;
    }
    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.data);
      else pending.reject(new Error(message.error || `Subagent RPC command ${message.command ?? "unknown"} failed`));
      return;
    }
    for (const listener of [...this.events]) listener(message as RpcEvent);
  }

  private cancelDialog(request: any): void {
    if (typeof request.id !== "string") return;
    if (!["select", "confirm", "input", "editor"].includes(request.method)) return;
    const response = request.method === "confirm"
      ? { type: "extension_ui_response", id: request.id, confirmed: false }
      : { type: "extension_ui_response", id: request.id, cancelled: true };
    try {
      this.write(response);
    } catch {
      // Process failure will reject pending work.
    }
  }

  private request(command: Record<string, unknown>): Promise<unknown> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const id = `subagent-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${String(command.type)}${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`));
      }, this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ ...command, id });
      } catch (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (pending) clearTimeout(pending.timer);
        reject(toError(error));
      }
    });
  }

  private write(message: unknown): void {
    const child = this.child;
    if (this.terminalError) throw this.terminalError;
    if (!child || child.exitCode !== null || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error(`Subagent stdin is unavailable${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`);
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.stopReader?.();
    this.stopReader = undefined;
    this.rejectPending(error);
    if (!this.stopping) for (const listener of [...this.exits]) listener(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function readJsonLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onError: (error: Error) => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    buffer = "";
    onError(new Error(`Subagent RPC record exceeded ${MAX_RECORD_BYTES} bytes`));
  };
  const drain = () => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) return fail();
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
      if (failed) return;
    }
  };
  const onData = (chunk: Buffer | string) => {
    if (failed) return;
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    drain();
    if (!failed && Buffer.byteLength(buffer) > MAX_RECORD_BYTES) fail();
  };
  const onEnd = () => {
    if (failed) return;
    buffer += decoder.end();
    if (Buffer.byteLength(buffer) > MAX_RECORD_BYTES) fail();
    else if (buffer) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    buffer = "";
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

function boundedTail(before: string, chunk: string, maxBytes: number): string {
  const combined = Buffer.from(before + chunk);
  if (combined.byteLength <= maxBytes) return combined.toString("utf8");
  const marker = "[earlier stderr omitted]\n";
  const markerBytes = Buffer.byteLength(marker);
  const tail = combined.subarray(combined.byteLength - Math.max(0, maxBytes - markerBytes));
  let tailText = tail.toString("utf8");
  while (Buffer.byteLength(marker + tailText) > maxBytes && tailText) tailText = tailText.slice(1);
  return marker + tailText;
}

function installExitReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  process.on("exit", () => {
    for (const pid of liveProcessGroups) killProcessTree(pid, "SIGKILL");
    liveProcessGroups.clear();
  });
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
    const result = spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    if (!result.error && result.status === 0) return;
  }
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (closed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
