import { createHash } from "node:crypto";

export const MONITOR_STATE_VERSION = 1;
export const MIN_MONITOR_INTERVAL_MS = 10_000;
export const MAX_MONITOR_INTERVAL_MS = 3_600_000;
export const MONITOR_LIFETIME_MS = 12 * 60 * 60 * 1_000;
export const DEFAULT_MAX_MONITOR_RUNS = 100;
export const MAX_MONITOR_RUNS = 500;
export const MAX_MONITOR_COMMAND_CHARS = 8_000;
export const MAX_MONITOR_REASON_CHARS = 1_000;
export const MAX_ACTIVE_MONITORS = 4;
export const MAX_RETAINED_MONITORS = 16;

export type MonitorCondition = "change" | "failure" | "success" | "always";
export type MonitorStatus = "active" | "paused" | "stopped" | "expired";

export interface MonitorJob {
  id: string;
  command: string;
  condition: MonitorCondition;
  status: MonitorStatus;
  intervalMs: number;
  nextRunAt: number | null;
  createdAt: number;
  expiresAt: number;
  runs: number;
  maxRuns: number;
  lastSignature?: string;
  lastExitCode?: number;
  lastRunAt?: number;
  lastWakeReason?: string;
  stopReason?: string;
  pendingFinalAlert?: PendingFinalAlert;
  finalRetryReason?: string;
}

export interface PendingFinalAlert {
  limitReason: string;
  previousSignature?: string;
  previousExitCode?: number;
  previousRunAt?: number;
  previousWakeReason?: string;
}

export interface MonitorSnapshot {
  version: typeof MONITOR_STATE_VERSION;
  jobs: MonitorJob[];
}

export interface MonitorCommand {
  intervalMs: number;
  command: string;
  condition: MonitorCondition;
  maxRuns: number;
}

export interface MonitorObservation {
  code: number;
  killed: boolean;
  stdout: string;
  stderr: string;
  stdoutDigest?: string;
  stderrDigest?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export function parseMonitorCommand(input: string): MonitorCommand | undefined {
  const separator = /\s--\s/.exec(input);
  if (!separator) return undefined;
  const settings = input.slice(0, separator.index).trim().split(/\s+/).filter(Boolean);
  const command = input.slice(separator.index + separator[0].length).trim();
  if (settings.length === 0 || !command || command.length > MAX_MONITOR_COMMAND_CHARS) return undefined;

  const intervalMs = parseMonitorDuration(settings.shift()!);
  if (intervalMs === undefined) return undefined;
  let condition: MonitorCondition = "change";
  let maxRuns = DEFAULT_MAX_MONITOR_RUNS;
  while (settings.length > 0) {
    const option = settings.shift();
    if (option === "--on") {
      const value = settings.shift();
      if (!isCondition(value)) return undefined;
      condition = value;
    } else if (option === "--max-runs") {
      const value = Number(settings.shift());
      if (!Number.isInteger(value) || value < 1 || value > MAX_MONITOR_RUNS) return undefined;
      maxRuns = value;
    } else {
      return undefined;
    }
  }
  return { intervalMs, command, condition, maxRuns };
}

export function parseMonitorDuration(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)$/i.exec(value.trim());
  if (!match) return undefined;
  const factor = match[2]!.toLowerCase() === "s" ? 1_000 : match[2]!.toLowerCase() === "m" ? 60_000 : 3_600_000;
  const milliseconds = Math.ceil(Number(match[1]) * factor);
  return Number.isFinite(milliseconds)
    && milliseconds >= MIN_MONITOR_INTERVAL_MS
    && milliseconds <= MAX_MONITOR_INTERVAL_MS
    ? milliseconds
    : undefined;
}

export function createMonitor(input: MonitorCommand, now = Date.now(), id = crypto.randomUUID().slice(0, 8)): MonitorJob {
  return {
    id,
    command: input.command,
    condition: input.condition,
    status: "active",
    intervalMs: input.intervalMs,
    nextRunAt: now,
    createdAt: now,
    expiresAt: now + MONITOR_LIFETIME_MS,
    runs: 0,
    maxRuns: input.maxRuns,
  };
}

export function applyObservation(job: MonitorJob, result: MonitorObservation, now = Date.now()): {
  job: MonitorJob;
  wake: boolean;
  reason?: string;
  signature: string;
} {
  const signature = observationSignature(result);
  const changed = job.lastSignature !== undefined && signature !== job.lastSignature;
  const first = job.lastSignature === undefined;
  const reason = job.condition === "always"
    ? "every observation"
    : job.condition === "failure" && result.code !== 0 && (first || changed)
      ? `command failed with exit ${result.code}`
      : job.condition === "success" && result.code === 0 && (first || changed)
        ? "command succeeded"
        : job.condition === "change" && changed
          ? "command output or exit status changed"
          : undefined;
  const runs = job.runs + 1;
  const limitReason = job.finalRetryReason
    ?? (runs >= job.maxRuns ? `${job.maxRuns}-run limit reached.` : now >= job.expiresAt ? "Twelve-hour lifetime reached." : undefined);
  const limited = Boolean(limitReason);
  const pendingFinalAlert = limited && reason ? {
    limitReason: limitReason!,
    previousSignature: job.lastSignature,
    previousExitCode: job.lastExitCode,
    previousRunAt: job.lastRunAt,
    previousWakeReason: job.lastWakeReason,
  } satisfies PendingFinalAlert : undefined;
  return {
    job: {
      ...job,
      status: limited && !pendingFinalAlert ? "expired" : "active",
      nextRunAt: limited ? null : now + job.intervalMs,
      runs,
      lastSignature: signature,
      lastExitCode: result.code,
      lastRunAt: now,
      lastWakeReason: reason ?? job.lastWakeReason,
      stopReason: limited && !pendingFinalAlert ? limitReason : undefined,
      pendingFinalAlert,
      finalRetryReason: undefined,
    },
    wake: Boolean(reason),
    reason,
    signature,
  };
}

export function pauseMonitor(job: MonitorJob, reason: string): MonitorJob {
  const pending = job.pendingFinalAlert;
  return {
    ...job,
    status: "paused",
    nextRunAt: null,
    runs: pending ? Math.max(0, job.runs - 1) : job.runs,
    lastSignature: pending ? pending.previousSignature : job.lastSignature,
    lastExitCode: pending ? pending.previousExitCode : job.lastExitCode,
    lastRunAt: pending ? pending.previousRunAt : job.lastRunAt,
    lastWakeReason: pending ? pending.previousWakeReason : job.lastWakeReason,
    pendingFinalAlert: undefined,
    finalRetryReason: pending?.limitReason ?? job.finalRetryReason,
    stopReason: boundedReason(reason),
  };
}

export function resumeMonitor(job: MonitorJob, now = Date.now()): MonitorJob {
  if (!job.finalRetryReason && (now >= job.expiresAt || job.runs >= job.maxRuns)) throw new Error("This monitor has reached its lifetime or run limit.");
  return { ...job, status: "active", nextRunAt: now, stopReason: undefined };
}

export function stopMonitor(job: MonitorJob, reason: string): MonitorJob {
  return { ...job, status: "stopped", nextRunAt: null, pendingFinalAlert: undefined, finalRetryReason: undefined, stopReason: boundedReason(reason) };
}

export function enforceMonitorLimits(job: MonitorJob, now = Date.now()): MonitorJob {
  if (job.status !== "active") return job;
  if (job.pendingFinalAlert) return pauseMonitor(job, "The final monitor alert did not settle before the session reloaded.");
  if (job.finalRetryReason) return job;
  if (now >= job.expiresAt) return { ...job, status: "expired", nextRunAt: null, stopReason: "Twelve-hour lifetime reached." };
  if (job.runs >= job.maxRuns) return { ...job, status: "expired", nextRunAt: null, stopReason: `${job.maxRuns}-run limit reached.` };
  return job;
}

export function completeMonitorAlert(job: MonitorJob): MonitorJob {
  if (!job.pendingFinalAlert) return job;
  return {
    ...job,
    status: "expired",
    nextRunAt: null,
    pendingFinalAlert: undefined,
    finalRetryReason: undefined,
    stopReason: job.pendingFinalAlert.limitReason,
  };
}

export function encodeMonitorSnapshot(jobs: Iterable<MonitorJob>): MonitorSnapshot {
  const all = [...jobs];
  const live = all.filter((job) => job.status === "active" || job.status === "paused");
  const terminal = all.filter((job) => job.status === "stopped" || job.status === "expired")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(0, MAX_RETAINED_MONITORS - live.length));
  return { version: MONITOR_STATE_VERSION, jobs: [...live, ...terminal].slice(0, MAX_RETAINED_MONITORS) };
}

export function decodeMonitorSnapshot(value: unknown): MonitorSnapshot | undefined {
  if (!record(value) || value.version !== MONITOR_STATE_VERSION || !Array.isArray(value.jobs) || value.jobs.length > MAX_RETAINED_MONITORS) return undefined;
  return { version: MONITOR_STATE_VERSION, jobs: value.jobs.map(decodeJob).filter((job): job is MonitorJob => Boolean(job)) };
}

export function observationSignature(result: MonitorObservation): string {
  if (!result.stdoutTruncated && !result.stderrTruncated) {
    return createHash("sha256")
      .update(String(result.code)).update("\0")
      .update(result.killed ? "1" : "0").update("\0")
      .update(result.stdout).update("\0").update(result.stderr)
      .digest("hex");
  }
  const stdout = validDigest(result.stdoutDigest) ? result.stdoutDigest : createHash("sha256").update(result.stdout).digest("hex");
  const stderr = validDigest(result.stderrDigest) ? result.stderrDigest : createHash("sha256").update(result.stderr).digest("hex");
  return createHash("sha256")
    .update(String(result.code)).update("\0")
    .update(result.killed ? "1" : "0").update("\0")
    .update(stdout).update("\0").update(stderr)
    .digest("hex");
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function decodeJob(value: unknown): MonitorJob | undefined {
  if (!record(value)
    || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)
    || typeof value.command !== "string" || !value.command.trim() || value.command.length > MAX_MONITOR_COMMAND_CHARS
    || !isCondition(value.condition) || !["active", "paused", "stopped", "expired"].includes(String(value.status))
    || typeof value.intervalMs !== "number" || !Number.isFinite(value.intervalMs) || value.intervalMs < MIN_MONITOR_INTERVAL_MS || value.intervalMs > MAX_MONITOR_INTERVAL_MS
    || (value.nextRunAt !== null && !timestamp(value.nextRunAt)) || !timestamp(value.createdAt) || !timestamp(value.expiresAt)
    || (value.status === "active" && !timestamp(value.nextRunAt) && value.pendingFinalAlert === undefined)
    || ((value.status === "paused" || value.status === "stopped" || value.status === "expired") && value.nextRunAt !== null)
    || value.expiresAt <= value.createdAt || !integer(value.runs, 0, MAX_MONITOR_RUNS)
    || !integer(value.maxRuns, 1, MAX_MONITOR_RUNS) || value.runs > value.maxRuns
    || (value.lastExitCode !== undefined && !Number.isInteger(value.lastExitCode))
    || (value.lastRunAt !== undefined && !timestamp(value.lastRunAt))
    || (value.lastSignature !== undefined && (typeof value.lastSignature !== "string" || !/^[a-f0-9]{64}$/.test(value.lastSignature)))
    || (value.lastWakeReason !== undefined && (typeof value.lastWakeReason !== "string" || value.lastWakeReason.length > MAX_MONITOR_REASON_CHARS))
    || (value.finalRetryReason !== undefined && (typeof value.finalRetryReason !== "string" || !value.finalRetryReason || value.finalRetryReason.length > MAX_MONITOR_REASON_CHARS))
    || (value.finalRetryReason !== undefined && value.status !== "active" && value.status !== "paused")
    || (value.pendingFinalAlert !== undefined && !decodePendingFinalAlert(value.pendingFinalAlert))
    || (value.pendingFinalAlert !== undefined && (value.status !== "active" || value.nextRunAt !== null || value.finalRetryReason !== undefined || value.runs < 1))
    || (value.stopReason !== undefined && (typeof value.stopReason !== "string" || value.stopReason.length > MAX_MONITOR_REASON_CHARS))) return undefined;
  return value as unknown as MonitorJob;
}

function decodePendingFinalAlert(value: unknown): value is PendingFinalAlert {
  return record(value)
    && typeof value.limitReason === "string" && Boolean(value.limitReason) && value.limitReason.length <= MAX_MONITOR_REASON_CHARS
    && (value.previousSignature === undefined || validDigest(value.previousSignature))
    && (value.previousExitCode === undefined || Number.isInteger(value.previousExitCode))
    && (value.previousRunAt === undefined || timestamp(value.previousRunAt))
    && (value.previousWakeReason === undefined || (typeof value.previousWakeReason === "string" && value.previousWakeReason.length <= MAX_MONITOR_REASON_CHARS));
}

function isCondition(value: unknown): value is MonitorCondition {
  return value === "change" || value === "failure" || value === "success" || value === "always";
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundedReason(value: string): string {
  return value.trim().slice(0, MAX_MONITOR_REASON_CHARS);
}
