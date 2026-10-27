import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { startProcess, terminalSize, type JobProcess } from "./transport.ts";
import { OutputLog, PlainOutput, type OutputSlice, type OutputWindow } from "../../lib/output.ts";
import { StreamRedactor, redactText } from "../../lib/redact.ts";
import { registerProcessExitReaper } from "../../lib/process-exit-reaper.ts";

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
  /** Keep a writable stdin pipe for pipe jobs. Otherwise stdin is closed (EOF). PTYs always accept input. */
  stdin?: boolean;
}
export const MAX_ACTIVE_JOBS = 16;
export const MAX_RETAINED_JOBS = 50;
export const LOG_CAPACITY = 128_000;
export const MAX_WAIT_MS = 300_000;
/** How often a wait checks for a queued user message. */
export const PENDING_MESSAGE_POLL_MS = 250;
/** Output waits return after this much quiet, or this long after the first new output. */
export const OUTPUT_QUIET_MS = 25;
export const OUTPUT_BATCH_MS = 250;
/** Why a bounded wait returned. */
export type WaitEnd = "exit" | "output" | "deadline" | "interrupted" | "message";
export interface WaitOptions {
  signal?: AbortSignal;
  /** `output` also returns once output arrives past `cursor` (default: the current end). */
  until?: "exit" | "output";
  cursor?: number;
  /** Polled while waiting; true ends the wait with `message`. */
  pending?: () => boolean;
}
/** How long output may keep arriving after the process group is gone before escaped holders are detached. */
export const DRAIN_MS = 500;
/** Extra time shutdown allows beyond the TERM grace period before abandoning stuck jobs. */
export const SHUTDOWN_SLACK_MS = 2000;
interface Job {
  snapshot: Omit<JobSnapshot, "outputStart" | "outputEnd" | "tail">;
  child: JobProcess; log: OutputLog; done: Promise<void>; resolve: () => void;
  timeout?: ReturnType<typeof setTimeout>; force?: ReturnType<typeof setTimeout>;
  groupPoll?: ReturnType<typeof setInterval>; drain?: ReturnType<typeof setTimeout>;
  streamsClosed: boolean; leaderExited: boolean;
  forced: boolean; stopping?: "stopped" | "timed-out"; pendingWrites: number;
  secretValues: string[]; flush: (() => void)[];
  /** Hard-exit cleanup for the live process group; disposed when the job settles. */
  unreap?: () => void;
}
export const isActive = (status: JobStatus) => ["starting", "running", "stopping"].includes(status);

/** Synchronous hard-exit kill of a process group; asynchronous cleanup cannot run during `exit`. */
function reapGroup(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", timeout: 1000, windowsHide: true });
  else { try { process.kill(-pid, "SIGKILL"); } catch {} }
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
    if (this.list().filter((job) => isActive(job.status)).length >= MAX_ACTIVE_JOBS) throw new Error(`${MAX_ACTIVE_JOBS} jobs are already active. Stop one before starting another.`);
    if (!input.command.trim() || input.command.length > 16000) throw new Error("Command must contain 1–16000 characters.");
    if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 86400000)) throw new Error("Timeout must be 100–86400000 milliseconds.");
    while (this.jobs.size >= MAX_RETAINED_JOBS) {
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
      child, log: new OutputLog(LOG_CAPACITY), done: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve(),
      streamsClosed: false, leaderExited: false, forced: false, pendingWrites: 0,
      secretValues: known, flush: [],
    };
    this.jobs.set(job.snapshot.id, job);
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      const decoder = new StringDecoder("utf8");
      const sanitizer = new PlainOutput();
      const redactor = new StreamRedactor(() => [...known, ...this.secrets()]);
      const displayRedactor = new StreamRedactor(() => [...known, ...this.secrets()]);
      let flushed = false;
      const flush = () => {
        if (flushed) return;
        flushed = true;
        job.log.append(displayRedactor.push(sanitizer.push(redactor.push(decoder.end(), true)), true));
      };
      stream.on("data", (chunk: Buffer) => {
        if (flushed) return;
        job.log.append(displayRedactor.push(sanitizer.push(redactor.push(decoder.write(chunk)))));
        this.emit(job, true);
      });
      stream.on("end", flush);
      job.flush.push(flush);
    }
    // A closed input stream is an ordinary job outcome, not an unhandled error.
    child.stdin?.on("error", () => {});
    child.once("spawn", () => {
      const pid = child.pid!;
      if (isActive(job.snapshot.status)) job.unreap = registerProcessExitReaper(() => reapGroup(pid));
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
      this.settle(job);
    });
    child.once("close", () => {
      job.streamsClosed = true;
      this.settle(job);
    });
    if (input.timeoutMs) {
      job.timeout = setTimeout(() => this.stop(job.snapshot.id, "timed-out"), input.timeoutMs);
      job.timeout.unref?.();
    }
    this.emit(job);
    return this.snapshot(job);
  }

  output(id: string, cursor?: number): OutputSlice { return this.require(id).log.read(cursor); }
  /** Bounded read with a caller-chosen limit; `newest` returns the end of the unread range. */
  window(id: string, cursor: number | undefined, limit: number, newest: boolean): OutputWindow {
    return this.require(id).log.window(cursor, limit, newest);
  }

  async write(id: string, text: string, eof = false, signal?: AbortSignal): Promise<JobSnapshot> {
    signal?.throwIfAborted();
    const job = this.require(id);
    if (job.snapshot.pty && eof) throw new Error("PTY input cannot be half-closed. Send \u0004 for terminal EOF or use job_stop.");
    if (!job.snapshot.pty && !job.child.stdin) throw new Error("Job input is closed: pipe jobs start with stdin at EOF unless started with stdin: true.");
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
      this.settle(job);
    }, this.graceMs);
    job.force.unref?.();
    this.emit(job);
    return this.snapshot(job);
  }

  /** Wait for exit or the deadline; rejects on cancellation. */
  async wait(id: string, milliseconds = 1000, signal?: AbortSignal): Promise<JobSnapshot> {
    signal?.throwIfAborted();
    if (await this.waitFor(id, milliseconds, { signal }) === "interrupted") throw new Error("Wait cancelled; the job is still managed. Use job_stop to stop it.");
    return this.get(id);
  }

  /** Bounded wait that resolves why it ended instead of rejecting. Never stops the job. */
  async waitFor(id: string, milliseconds: number, options: WaitOptions = {}): Promise<WaitEnd> {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > MAX_WAIT_MS) throw new Error(`Wait must be 0–${MAX_WAIT_MS} milliseconds.`);
    const job = this.require(id);
    const { signal, until = "exit", cursor = job.log.end, pending } = options;
    const queued = () => { try { return !!pending?.(); } catch { return false; } };
    if (!isActive(job.snapshot.status)) return "exit";
    if (signal?.aborted) return "interrupted";
    if (milliseconds === 0) return "deadline";
    if (queued()) return "message";
    return new Promise<WaitEnd>((resolve) => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      let batch: ReturnType<typeof setTimeout> | undefined;
      const finish = (end: WaitEnd) => {
        clearTimeout(deadline); clearTimeout(quiet); clearTimeout(batch); clearInterval(poll);
        signal?.removeEventListener("abort", abort);
        unsubscribe();
        resolve(end);
      };
      const abort = () => finish("interrupted");
      const check = () => {
        if (!isActive(job.snapshot.status)) return finish("exit");
        if (until !== "output" || job.log.end <= cursor) return;
        clearTimeout(quiet);
        quiet = setTimeout(() => finish("output"), OUTPUT_QUIET_MS);
        batch ??= setTimeout(() => finish("output"), OUTPUT_BATCH_MS);
      };
      const deadline = setTimeout(() => finish("deadline"), milliseconds);
      const poll = pending ? setInterval(() => { if (queued()) finish("message"); }, PENDING_MESSAGE_POLL_MS) : undefined;
      const unsubscribe = this.subscribe((snapshot) => { if (snapshot.id === id) check(); });
      signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  /** Stop every job. Bounded: jobs still unsettled after grace + slack are detached and marked stopped. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) if (isActive(job.snapshot.status)) this.stop(job.snapshot.id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(jobs.map((job) => job.done)),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, this.graceMs + SHUTDOWN_SLACK_MS); }),
    ]);
    clearTimeout(timer);
    for (const job of jobs) if (isActive(job.snapshot.status)) { this.kill(job, "SIGKILL"); this.detach(job); }
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
    clearTimeout(job.timeout); clearTimeout(job.force); clearInterval(job.groupPoll); clearTimeout(job.drain);
    job.snapshot.status = status ?? job.stopping ?? (job.snapshot.code === 0 ? "completed" : "failed");
    job.snapshot.endedAt = Date.now();
    job.secretValues.length = 0;
    job.unreap?.();
    this.emit(job);
    job.resolve();
  }
  /**
   * Finish once the process group is gone and output has closed. When a
   * daemonized descendant escapes the group but keeps the pipes open, allow a
   * short drain and then detach from its streams instead of waiting for it.
   */
  private settle(job: Job): void {
    if (!isActive(job.snapshot.status) || !job.leaderExited && !job.streamsClosed && !job.forced) return;
    const check = () => {
      if (!isActive(job.snapshot.status)) return true;
      if (process.platform !== "win32" && !job.forced && this.groupAlive(job)) return false;
      if (job.streamsClosed) this.finish(job);
      else if (!job.drain) { job.drain = setTimeout(() => this.detach(job), DRAIN_MS); job.drain.unref?.(); }
      return true;
    };
    if (check() || job.groupPoll) return;
    job.groupPoll = setInterval(() => { if (check()) { clearInterval(job.groupPoll); job.groupPoll = undefined; } }, 100);
    job.groupPoll.unref?.();
  }
  private detach(job: Job): void {
    for (const flush of job.flush) flush();
    job.child.stdin?.destroy(); job.child.stdout?.destroy(); job.child.stderr?.destroy();
    this.finish(job);
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
