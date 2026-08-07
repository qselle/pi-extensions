import { MAX_LOOP_INTERVAL_MS, MIN_LOOP_INTERVAL_MS } from "./interval.ts";

export const LOOP_STATE_VERSION = 2;
export const MAX_ACTIVE_LOOPS = 8;
export const MAX_RETAINED_LOOPS = 24;
export const MAX_LOOP_PROMPT_CHARS = 25_000;
export const MAX_LOOP_REASON_CHARS = 1_000;
export const DEFAULT_MAX_ITERATIONS = 25;
export const DEFAULT_LOOP_LIFETIME_MS = 12 * 60 * 60 * 1_000;
export const DEFAULT_DYNAMIC_FALLBACK_MS = 20 * 60 * 1_000;
export const MAX_CONTEXT_PERCENT = 90;
const LEGACY_MAX_LOOP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type LoopMode = "dynamic" | "fixed";
export type LoopStatus = "active" | "paused" | "stopped" | "expired";

export interface LoopJob {
  id: string;
  prompt: string;
  promptSource: "explicit" | "default";
  mode: LoopMode;
  status: LoopStatus;
  intervalMs: number | null;
  nextRunAt: number | null;
  createdAt: number;
  expiresAt: number;
  iterations: number;
  maxIterations: number;
  fallbackWakeups: number;
  lastScheduleReason?: string;
  stopReason?: string;
}

export interface LoopSnapshot {
  version: typeof LOOP_STATE_VERSION;
  jobs: LoopJob[];
}

export function createLoop(
  prompt: string,
  intervalMs: number | null,
  now = Date.now(),
  id = crypto.randomUUID().slice(0, 8),
  promptSource: LoopJob["promptSource"] = "explicit",
): LoopJob {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) throw new Error("A loop prompt is required.");
  if (normalizedPrompt.length > MAX_LOOP_PROMPT_CHARS) {
    throw new Error(`Loop prompts are limited to ${MAX_LOOP_PROMPT_CHARS.toLocaleString()} characters.`);
  }
  if (intervalMs !== null && (intervalMs < MIN_LOOP_INTERVAL_MS || intervalMs > MAX_LOOP_INTERVAL_MS)) {
    throw new Error("Fixed loop intervals must be between 1 minute and 1 hour.");
  }
  return {
    id,
    prompt: normalizedPrompt,
    promptSource,
    mode: intervalMs === null ? "dynamic" : "fixed",
    status: "active",
    intervalMs,
    nextRunAt: now,
    createdAt: now,
    expiresAt: now + DEFAULT_LOOP_LIFETIME_MS,
    iterations: 0,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    fallbackWakeups: 0,
  };
}

export function scheduleDynamicLoop(
  job: LoopJob,
  delayMs: number,
  reason: string | undefined,
  now = Date.now(),
): LoopJob {
  if (job.mode !== "dynamic" || job.status !== "active") {
    throw new Error("Only an active dynamic loop can schedule its next wakeup.");
  }
  const boundedDelay = Math.max(MIN_LOOP_INTERVAL_MS, Math.min(MAX_LOOP_INTERVAL_MS, delayMs));
  return {
    ...job,
    nextRunAt: now + boundedDelay,
    fallbackWakeups: 0,
    lastScheduleReason: boundedReason(reason),
  };
}

export function scheduleDynamicFallback(job: LoopJob, now = Date.now()): LoopJob {
  return {
    ...job,
    nextRunAt: now + DEFAULT_DYNAMIC_FALLBACK_MS,
    fallbackWakeups: job.fallbackWakeups + 1,
    lastScheduleReason: "Automatic fallback because the iteration did not schedule a wakeup.",
  };
}

export function beginLoopIteration(job: LoopJob, now = Date.now()): LoopJob {
  if (job.status !== "active") return job;
  const next = job.mode === "fixed" ? nextFixedRun(job, now) : null;
  return { ...job, iterations: job.iterations + 1, nextRunAt: next };
}

export function nextFixedRun(job: LoopJob, now = Date.now()): number | null {
  if (job.intervalMs === null) return null;
  const anchor = job.nextRunAt ?? now;
  if (anchor > now) return anchor;
  const missed = Math.floor((now - anchor) / job.intervalMs) + 1;
  return anchor + missed * job.intervalMs;
}

export function stopLoop(job: LoopJob, status: "stopped" | "expired", reason: string): LoopJob {
  return { ...job, status, nextRunAt: null, stopReason: boundedReason(reason) };
}

export function pauseLoop(job: LoopJob, reason?: string): LoopJob {
  return { ...job, status: "paused", nextRunAt: null, stopReason: boundedReason(reason) };
}

export function resumeLoop(job: LoopJob, now = Date.now()): LoopJob {
  if (job.status === "expired" || now >= job.expiresAt || job.iterations >= job.maxIterations) {
    throw new Error("This loop has reached its lifetime or iteration limit and cannot resume.");
  }
  return { ...job, status: "active", nextRunAt: now, stopReason: undefined };
}

export function enforceLoopLimits(job: LoopJob, now = Date.now()): LoopJob {
  if (job.status !== "active") return job;
  if (now >= job.expiresAt) return stopLoop(job, "expired", "Twelve-hour lifetime reached.");
  if (job.iterations >= job.maxIterations) {
    return stopLoop(job, "expired", `${job.maxIterations}-iteration limit reached.`);
  }
  return job;
}

export function encodeLoopSnapshot(jobs: Iterable<LoopJob>): LoopSnapshot {
  const all = [...jobs];
  const live = all.filter((job) => job.status === "active" || job.status === "paused");
  const recentTerminal = all
    .filter((job) => job.status === "stopped" || job.status === "expired")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(0, MAX_RETAINED_LOOPS - live.length));
  return { version: LOOP_STATE_VERSION, jobs: [...live, ...recentTerminal].slice(0, MAX_RETAINED_LOOPS) };
}

export function decodeLoopSnapshot(value: unknown): LoopSnapshot | undefined {
  if (!isRecord(value) || (value.version !== 1 && value.version !== LOOP_STATE_VERSION) || !Array.isArray(value.jobs)) {
    return undefined;
  }
  const maximumInterval = value.version === 1 ? LEGACY_MAX_LOOP_INTERVAL_MS : MAX_LOOP_INTERVAL_MS;
  const jobs = value.jobs.map((job) => decodeLoopJob(job, maximumInterval)).filter((job): job is LoopJob => Boolean(job));
  return { version: LOOP_STATE_VERSION, jobs };
}

function decodeLoopJob(value: unknown, maximumInterval: number): LoopJob | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string"
    || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)
    || typeof value.prompt !== "string"
    || value.prompt.trim().length === 0
    || value.prompt.length > MAX_LOOP_PROMPT_CHARS
    || (value.promptSource !== undefined && value.promptSource !== "explicit" && value.promptSource !== "default")
    || (value.mode !== "dynamic" && value.mode !== "fixed")
    || !["active", "paused", "stopped", "expired"].includes(String(value.status))
    || (value.mode === "dynamic" ? value.intervalMs !== null : !validInterval(value.intervalMs, maximumInterval))
    || (value.nextRunAt !== null && !validTimestamp(value.nextRunAt))
    || !validTimestamp(value.createdAt)
    || !validTimestamp(value.expiresAt)
    || value.expiresAt <= value.createdAt
    || !isBoundedInteger(value.iterations, 0, 1_000)
    || !isBoundedInteger(value.maxIterations, 1, 1_000)
    || value.iterations > value.maxIterations
    || !isBoundedInteger(value.fallbackWakeups, 0, 2)
    || (value.lastScheduleReason !== undefined && (typeof value.lastScheduleReason !== "string" || value.lastScheduleReason.length > MAX_LOOP_REASON_CHARS))
    || (value.stopReason !== undefined && (typeof value.stopReason !== "string" || value.stopReason.length > MAX_LOOP_REASON_CHARS))
  ) return undefined;
  return {
    ...value,
    promptSource: value.promptSource === "default" ? "default" : "explicit",
  } as unknown as LoopJob;
}

function validInterval(value: unknown, maximum: number): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= MIN_LOOP_INTERVAL_MS
    && value <= maximum;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function boundedReason(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, MAX_LOOP_REASON_CHARS) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
