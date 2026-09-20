import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { startProcess, terminalSize, type JobProcess } from "./transport.ts";
import { OutputLog, PlainOutput, type OutputSlice } from "../../lib/output.ts";
import { StreamRedactor, redactText } from "../../lib/redact.ts";

export type JobStatus = "starting" | "running" | "stopping" | "completed" | "failed" | "stopped" | "timed-out" | "interrupted";
export interface JobSnapshot {
  id: string; name: string; command: string; cwd: string; status: JobStatus;
  startedAt: number; endedAt?: number; code?: number | null; signal?: string | null;
  pty?: boolean; columns?: number; rows?: number;
  outputStart: number; outputEnd: number; tail: string; error?: string;
}
export interface StartJob {
  name: string; command: string; cwd: string; executable: string; args: string[];
  env?: NodeJS.ProcessEnv; timeoutMs?: number; pty?: boolean; columns?: number; rows?: number;
}
interface Job {
  snapshot: Omit<JobSnapshot, "outputStart" | "outputEnd" | "tail">;
  child: JobProcess; log: OutputLog; done: Promise<void>; resolve: () => void;
  timeout?: ReturnType<typeof setTimeout>; force?: ReturnType<typeof setTimeout>;
  groupPoll?: ReturnType<typeof setInterval>; streamsClosed: boolean; leaderExited: boolean;
  forced: boolean; stopping?: "stopped" | "timed-out"; pendingWrites: number;
  secretValues: string[];
}
export const isActive = (status: JobStatus) => ["starting", "running", "stopping"].includes(status);

const REAPER = Symbol.for("@qselle/pi-extensions.job-reaper.v1");
const globalState = globalThis as Record<PropertyKey, unknown>;
const reapers = (globalState[REAPER] ??= new Map<number, () => void>()) as Map<number, () => void>;
const installed = Symbol.for("@qselle/pi-extensions.job-reaper-installed.v1");
if (!globalState[installed]) {
  globalState[installed] = true;
  process.once("exit", () => { for (const reap of reapers.values()) { try { reap(); } catch {} } });
}

export class JobService {
  private jobs = new Map<string, Job>();
  private listeners = new Set<(job: JobSnapshot, output: boolean) => void>();
  private closed = false;
  private readonly graceMs: number;
  private readonly secrets: () => readonly string[];
  constructor(graceMs = 3000, secrets: () => readonly string[] = () => []) { this.graceMs = graceMs; this.secrets = secrets; }
  subscribe(listener: (job: JobSnapshot, output: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  list(): JobSnapshot[] { return [...this.jobs.values()].map((job) => this.snapshot(job)); }
  get(id: string): JobSnapshot { return this.snapshot(this.require(id)); }

  start(input: StartJob, signal?: AbortSignal): JobSnapshot {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Background job service is closed.");
    if (this.list().filter((job) => isActive(job.status)).length >= 4) throw new Error("Four jobs are already active. Stop one before starting another.");
    if (!input.command.trim() || input.command.length > 16000) throw new Error("Command must contain 1–16000 characters.");
    if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 86400000)) throw new Error("Timeout must be 100–86400000 milliseconds.");
    while (this.jobs.size >= 24) {
      const old = [...this.jobs.values()].find((job) => !isActive(job.snapshot.status));
      if (!old) break;
      this.jobs.delete(old.snapshot.id);
    }
    const known = [...this.secrets()];
    const clean = (value: string) => redactText(new PlainOutput().push(redactText(value, [...known, ...this.secrets()])), [...known, ...this.secrets()]).replace(/\s+/g, " ").trim();
    const size = input.pty ? terminalSize(input.columns, input.rows) : undefined;
    const child = startProcess(input);
    let resolve!: () => void;
    const job: Job = {
      snapshot: { id: randomUUID().slice(0, 8), name: clean(input.name).slice(0, 80) || "Background job", command: clean(input.command), cwd: clean(input.cwd), pty: !!input.pty, ...size, status: "starting", startedAt: Date.now() },
      child, log: new OutputLog(), done: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve(),
      streamsClosed: false, leaderExited: false, forced: false, pendingWrites: 0,
      secretValues: known,
    };
    this.jobs.set(job.snapshot.id, job);
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      const sanitizer = new PlainOutput();
      const redactor = new StreamRedactor(() => [...known, ...this.secrets()]);
      const displayRedactor = new StreamRedactor(() => [...known, ...this.secrets()]);
      stream?.on("data", (chunk: Buffer) => {
        job.log.append(displayRedactor.push(sanitizer.push(redactor.push(decoder.write(chunk)))));
        this.emit(job, true);
      });
      stream?.on("end", () => { job.log.append(displayRedactor.push(sanitizer.push(redactor.push(decoder.end(), true)), true)); });
    }
    // A closed input stream is an ordinary job outcome, not an unhandled error.
    child.stdin?.on("error", () => {});
    child.once("spawn", () => {
      const pid = child.pid!;
      reapers.set(pid, () => {
        if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", timeout: 1000, windowsHide: true });
        else { try { process.kill(-pid, "SIGKILL"); } catch {} }
      });
      if (job.stopping) this.kill(job, "SIGTERM");
      else job.snapshot.status = "running";
      this.emit(job);
    });
    child.once("error", (error) => {
      job.snapshot.error = clean(error.message);
      this.finish(job, "failed");
    });
    child.once("exit", (code, signal) => {
      job.leaderExited = true;
      job.snapshot.code = code;
      job.snapshot.signal = signal;
    });
    child.once("close", () => {
      job.streamsClosed = true;
      if (process.platform !== "win32" && !job.forced && this.groupAlive(job)) {
        job.groupPoll = setInterval(() => { if (!this.groupAlive(job)) this.finish(job); }, 100);
        job.groupPoll.unref?.();
      } else this.finish(job);
    });
    if (input.timeoutMs) {
      job.timeout = setTimeout(() => this.stop(job.snapshot.id, "timed-out"), input.timeoutMs);
      job.timeout.unref?.();
    }
    this.emit(job);
    return this.snapshot(job);
  }

  output(id: string, cursor?: number): OutputSlice { return this.require(id).log.read(cursor); }

  async write(id: string, text: string, eof = false, signal?: AbortSignal): Promise<JobSnapshot> {
    signal?.throwIfAborted();
    const job = this.require(id);
    if (job.snapshot.pty && eof) throw new Error("PTY input cannot be half-closed. Send \u0004 for terminal EOF or use job_stop.");
    if (!isActive(job.snapshot.status) || job.stopping || !job.child.stdin?.writable) throw new Error("Job input is closed.");
    for (const secret of this.secrets()) if (!job.secretValues.includes(secret)) job.secretValues.push(secret);
    if (text.length > 16000 || job.pendingWrites >= 2) throw new Error("Input exceeds the pending write limit.");
    job.pendingWrites++;
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          job.child.stdin?.destroy();
          cleanup();
          reject(new Error("Input write cancelled or timed out; job stdin was closed."));
        };
        const timer = setTimeout(abort, 10000);
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
        signal?.addEventListener("abort", abort, { once: true });
        job.child.stdin!.write(text, (error) => {
          cleanup();
          if (error) reject(new Error("Job input closed before the write completed."));
          else resolve();
        });
      });
      if (eof) job.child.stdin.end();
    } finally { job.pendingWrites--; }
    return this.snapshot(job);
  }

  resize(id: string, columns: number, rows: number): JobSnapshot {
    terminalSize(columns, rows);
    const job = this.require(id);
    if (!job.child.resize) throw new Error("Only PTY jobs can be resized.");
    if (!isActive(job.snapshot.status) || job.stopping) throw new Error("Terminal is no longer running.");
    job.child.resize(columns, rows);
    job.snapshot.columns = columns; job.snapshot.rows = rows;
    this.emit(job);
    return this.snapshot(job);
  }

  stop(id: string, reason: "stopped" | "timed-out" = "stopped"): JobSnapshot {
    const job = this.require(id);
    if (!isActive(job.snapshot.status) || job.stopping) return this.snapshot(job);
    job.stopping = reason;
    job.snapshot.status = "stopping";
    job.child.stdin?.destroy();
    this.kill(job, "SIGTERM");
    job.force = setTimeout(() => {
      job.forced = true;
      this.kill(job, "SIGKILL");
      if (job.streamsClosed) this.finish(job);
    }, this.graceMs);
    this.emit(job);
    return this.snapshot(job);
  }

  async wait(id: string, milliseconds = 1000, signal?: AbortSignal): Promise<JobSnapshot> {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 30000) throw new Error("Wait must be 0–30000 milliseconds.");
    const job = this.require(id);
    if (!isActive(job.snapshot.status) || milliseconds === 0) return this.snapshot(job);
    await new Promise<void>((resolve, reject) => {
      const finish = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(new Error("Wait cancelled; the job is still managed. Use job_stop to stop it.")); };
      const timer = setTimeout(finish, milliseconds);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); unsubscribe(); };
      const unsubscribe = this.subscribe((snapshot, output) => { if (snapshot.id === id && !output && !isActive(snapshot.status)) finish(); });
      signal?.addEventListener("abort", abort, { once: true });
    });
    return this.snapshot(job);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) if (isActive(job.snapshot.status)) this.stop(job.snapshot.id);
    await Promise.all([...this.jobs.values()].map((job) => job.done));
    this.listeners.clear();
  }

  private snapshot(job: Job): JobSnapshot {
    return { ...job.snapshot, outputStart: job.log.start, outputEnd: job.log.end, tail: job.log.tail() };
  }
  private require(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown job ID (jobs belong to the current session and are not restored after reload).");
    return job;
  }
  private emit(job: Job, output = false): void {
    for (const listener of this.listeners) {
      try { listener(this.snapshot(job), output); } catch { /* UI failures cannot strand processes. */ }
    }
  }
  private finish(job: Job, status?: JobStatus): void {
    if (!isActive(job.snapshot.status)) return;
    clearTimeout(job.timeout); clearTimeout(job.force); clearInterval(job.groupPoll);
    job.snapshot.status = status ?? job.stopping ?? (job.snapshot.code === 0 ? "completed" : "failed");
    job.snapshot.endedAt = Date.now();
    job.secretValues.length = 0;
    if (job.child.pid) reapers.delete(job.child.pid);
    this.emit(job);
    job.resolve();
  }
  private groupAlive(job: Job): boolean {
    if (!job.child.pid) return false;
    try { process.kill(-job.child.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  }
  private kill(job: Job, signal: NodeJS.Signals): void {
    if (!job.child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(job.child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => {});
      killer.unref();
    } else {
      try { process.kill(-job.child.pid, signal); }
      catch { if (!job.leaderExited) job.child.kill(signal); }
    }
  }
}
