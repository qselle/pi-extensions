import { nextCronOccurrence, parseCron, validTimeZone, wallClockAt } from "./cron.ts";

export const SCHEDULE_STORE_VERSION = 1;
export const MAX_ACTIVE_SCHEDULES = 50;
export const MAX_STORED_SCHEDULES = 100;
export const MAX_SCHEDULE_PROMPT_CHARS = 25_000;
export const MAX_SCHEDULE_REASON_CHARS = 1_000;
export const MAX_SCHEDULE_RUNS = 500;
export const DEFAULT_CRON_RUNS = 50;
export const MIN_REMINDER_DELAY_MS = 60_000;
export const MAX_REMINDER_DELAY_MS = 365 * 24 * 60 * 60 * 1_000;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/i;

export type ScheduleKind = "reminder" | "cron";
export type ScheduleStatus = "active" | "paused" | "completed" | "stopped" | "expired";

export interface ScheduledTask {
  id: string;
  kind: ScheduleKind;
  prompt: string;
  status: ScheduleStatus;
  nextRunAt: number | null;
  createdAt: number;
  runs: number;
  maxRuns: number;
  cronExpression?: string;
  timeZone?: string;
  lastRunAt?: number;
  lastScheduledFor?: number;
  lastWallClock?: string;
  pendingDeliveryAt?: number;
  stopReason?: string;
}

export interface ScheduleStore {
  version: typeof SCHEDULE_STORE_VERSION;
  projectCwd: string;
  tasks: ScheduledTask[];
}

export interface ReminderInput { prompt: string; runAt: number }
export interface CronInput { prompt: string; expression: string; timeZone: string; maxRuns: number }

export function parseReminderCommand(input: string, now = Date.now()): ReminderInput | undefined {
  const split = splitPayload(input);
  if (!split) return undefined;
  const tokens = split.settings.split(/\s+/);
  let runAt: number;
  if (tokens[0]?.toLowerCase() === "at" && tokens.length === 2) {
    if (!validIsoTimestamp(tokens[1]!)) return undefined;
    runAt = Date.parse(tokens[1]!);
  } else {
    const durationToken = tokens[0]?.toLowerCase() === "in" && tokens.length === 2 ? tokens[1] : tokens.length === 1 ? tokens[0] : undefined;
    const delay = durationToken ? parseReminderDuration(durationToken) : undefined;
    if (delay === undefined) return undefined;
    runAt = now + delay;
  }
  if (!Number.isFinite(runAt) || runAt < now + MIN_REMINDER_DELAY_MS || runAt > now + MAX_REMINDER_DELAY_MS) return undefined;
  return { prompt: split.payload, runAt };
}

export function parseCronCommand(input: string): CronInput | undefined {
  const split = splitPayload(input);
  if (!split) return undefined;
  const tokens = split.settings.split(/\s+/).filter(Boolean);
  if (tokens.length < 5) return undefined;
  const expression = tokens.splice(0, 5).join(" ");
  if (!parseCron(expression)) return undefined;
  let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let maxRuns = DEFAULT_CRON_RUNS;
  while (tokens.length) {
    const option = tokens.shift();
    if (option === "--tz") {
      const value = tokens.shift();
      if (!value || !validTimeZone(value)) return undefined;
      timeZone = value;
    } else if (option === "--max-runs") {
      const value = Number(tokens.shift());
      if (!Number.isInteger(value) || value < 1 || value > MAX_SCHEDULE_RUNS) return undefined;
      maxRuns = value;
    } else return undefined;
  }
  return { prompt: split.payload, expression, timeZone, maxRuns };
}

export function createReminder(input: ReminderInput, now = Date.now(), id = crypto.randomUUID().slice(0, 8)): ScheduledTask {
  validatePrompt(input.prompt);
  return { id, kind: "reminder", prompt: input.prompt.trim(), status: "active", nextRunAt: input.runAt, createdAt: now, runs: 0, maxRuns: 1 };
}

export function createCronTask(input: CronInput, now = Date.now(), id = crypto.randomUUID().slice(0, 8)): ScheduledTask {
  validatePrompt(input.prompt);
  const nextRunAt = nextCronOccurrence(input.expression, now, input.timeZone);
  if (nextRunAt === undefined) throw new Error("The cron expression has no occurrence in the next eight years.");
  return {
    id, kind: "cron", prompt: input.prompt.trim(), status: "active", nextRunAt, createdAt: now,
    runs: 0, maxRuns: input.maxRuns, cronExpression: input.expression, timeZone: input.timeZone,
  };
}

export function markDeliveryPending(task: ScheduledTask): ScheduledTask {
  if (task.status !== "active" || task.nextRunAt === null) throw new Error("Only a due active task can be delivered.");
  return { ...task, pendingDeliveryAt: task.nextRunAt };
}

export function completeDelivery(task: ScheduledTask, now = Date.now()): ScheduledTask {
  const scheduledFor = task.pendingDeliveryAt ?? task.nextRunAt;
  if (scheduledFor === null || scheduledFor === undefined) throw new Error("This task has no pending delivery.");
  const runs = task.runs + 1;
  if (task.kind === "reminder") {
    return { ...task, status: "completed", nextRunAt: null, runs, lastRunAt: now, lastScheduledFor: scheduledFor, pendingDeliveryAt: undefined, stopReason: "One-shot reminder delivered." };
  }
  const wallClock = wallClockAt(scheduledFor, task.timeZone!);
  if (runs >= task.maxRuns) {
    return { ...task, status: "expired", nextRunAt: null, runs, lastRunAt: now, lastScheduledFor: scheduledFor, lastWallClock: wallClock, pendingDeliveryAt: undefined, stopReason: `${task.maxRuns}-run limit reached.` };
  }
  const nextRunAt = nextCronOccurrence(task.cronExpression!, Math.max(now, scheduledFor), task.timeZone!, wallClock);
  return nextRunAt === undefined
    ? { ...task, status: "expired", nextRunAt: null, runs, lastRunAt: now, lastScheduledFor: scheduledFor, lastWallClock: wallClock, pendingDeliveryAt: undefined, stopReason: "No next occurrence in the next eight years." }
    : { ...task, nextRunAt, runs, lastRunAt: now, lastScheduledFor: scheduledFor, lastWallClock: wallClock, pendingDeliveryAt: undefined };
}

export function pauseTask(task: ScheduledTask, reason: string): ScheduledTask {
  return { ...task, status: "paused", stopReason: boundedReason(reason) };
}

export function resumeTask(task: ScheduledTask, now = Date.now()): ScheduledTask {
  if (task.status !== "paused") throw new Error("Only a paused schedule can resume.");
  if (task.runs >= task.maxRuns) throw new Error("This schedule has reached its run limit.");
  if (task.pendingDeliveryAt !== undefined) {
    return { ...task, status: "active", nextRunAt: now, stopReason: undefined };
  }
  if (task.kind === "reminder") {
    if (task.nextRunAt === null) throw new Error("This reminder no longer has a delivery time.");
    return { ...task, status: "active", nextRunAt: Math.max(task.nextRunAt, now), stopReason: undefined };
  }
  const nextRunAt = nextCronOccurrence(task.cronExpression!, now, task.timeZone!, task.lastWallClock);
  if (nextRunAt === undefined) throw new Error("The cron expression has no occurrence in the next eight years.");
  return { ...task, status: "active", nextRunAt, pendingDeliveryAt: undefined, stopReason: undefined };
}

export function stopTask(task: ScheduledTask, reason: string): ScheduledTask {
  return { ...task, status: "stopped", nextRunAt: null, pendingDeliveryAt: undefined, stopReason: boundedReason(reason) };
}

export function decodeScheduleStore(value: unknown, expectedCwd: string): ScheduleStore | undefined {
  if (!record(value) || value.version !== SCHEDULE_STORE_VERSION || value.projectCwd !== expectedCwd
    || !Array.isArray(value.tasks) || value.tasks.length > MAX_STORED_SCHEDULES) return undefined;
  const tasks = value.tasks.map(decodeTask).filter((task): task is ScheduledTask => Boolean(task));
  if (tasks.length !== value.tasks.length || new Set(tasks.map((task) => task.id)).size !== tasks.length
    || tasks.filter((task) => task.status === "active" || task.status === "paused").length > MAX_ACTIVE_SCHEDULES) return undefined;
  return { version: SCHEDULE_STORE_VERSION, projectCwd: expectedCwd, tasks };
}

function decodeTask(value: unknown): ScheduledTask | undefined {
  const status = record(value) ? String(value.status) : "";
  if (!record(value) || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)
    || (value.kind !== "reminder" && value.kind !== "cron") || typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > MAX_SCHEDULE_PROMPT_CHARS
    || !["active", "paused", "completed", "stopped", "expired"].includes(String(value.status))
    || (value.nextRunAt !== null && !timestamp(value.nextRunAt)) || !timestamp(value.createdAt)
    || (status === "active" && !timestamp(value.nextRunAt))
    || (["completed", "stopped", "expired"].includes(status) && value.nextRunAt !== null)
    || !integer(value.runs, 0, MAX_SCHEDULE_RUNS) || !integer(value.maxRuns, 1, MAX_SCHEDULE_RUNS) || value.runs > value.maxRuns
    || (value.kind === "reminder" && (value.maxRuns !== 1 || value.cronExpression !== undefined || value.timeZone !== undefined))
    || (value.kind === "cron" && (typeof value.cronExpression !== "string" || !parseCron(value.cronExpression) || typeof value.timeZone !== "string" || !validTimeZone(value.timeZone)))
    || (value.lastRunAt !== undefined && !timestamp(value.lastRunAt)) || (value.lastScheduledFor !== undefined && !timestamp(value.lastScheduledFor))
    || (value.pendingDeliveryAt !== undefined && !timestamp(value.pendingDeliveryAt)) || (value.lastWallClock !== undefined && typeof value.lastWallClock !== "string")
    || (value.pendingDeliveryAt !== undefined && status !== "active" && status !== "paused")
    || (value.stopReason !== undefined && (typeof value.stopReason !== "string" || value.stopReason.length > MAX_SCHEDULE_REASON_CHARS))) return undefined;
  return value as unknown as ScheduledTask;
}

function splitPayload(input: string): { settings: string; payload: string } | undefined {
  const separator = /\s--\s/.exec(input);
  if (!separator) return undefined;
  const settings = input.slice(0, separator.index).trim();
  const payload = input.slice(separator.index + separator[0].length).trim();
  return settings && payload && payload.length <= MAX_SCHEDULE_PROMPT_CHARS ? { settings, payload } : undefined;
}

function parseReminderDuration(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(m|h|d|w)$/i.exec(value);
  if (!match) return undefined;
  const unit = match[2]!.toLowerCase();
  const factor = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
  const duration = Math.ceil(Number(match[1]) * factor);
  return Number.isFinite(duration) && duration >= MIN_REMINDER_DELAY_MS && duration <= MAX_REMINDER_DELAY_MS ? duration : undefined;
}

function validIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  return month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth(year, month)
    && hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59
    && offsetHour >= 0 && offsetHour <= 23
    && offsetMinute >= 0 && offsetMinute <= 59;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validatePrompt(prompt: string): void {
  if (!prompt.trim()) throw new Error("A schedule prompt is required.");
  if (prompt.length > MAX_SCHEDULE_PROMPT_CHARS) throw new Error(`Schedule prompts are limited to ${MAX_SCHEDULE_PROMPT_CHARS.toLocaleString()} characters.`);
}

function boundedReason(value: string): string { return value.trim().slice(0, MAX_SCHEDULE_REASON_CHARS); }

function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
