import { PlainOutput } from "../../lib/output.ts";
import { isActive, type JobSnapshot, type JobStatus } from "./service.ts";

export const JOB_HISTORY_ENTRY = "background-job-lifecycle";
const STATUSES = new Set<JobStatus>(["starting", "running", "stopping", "completed", "failed", "stopped", "timed-out", "interrupted"]);
const clean = (value: string, maximum: number) => {
  const text = new PlainOutput().push(value);
  let end = Math.min(maximum, text.length);
  if (end < text.length && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
  return text.slice(0, end);
};

/** Only bounded, already-redacted presentation data is persisted. Never PIDs or stdin. */
export function encodeJob(job: JobSnapshot): JobSnapshot & { version: 1 } {
  let start = Math.max(0, job.tail.length - 2000);
  if (job.tail.charCodeAt(start) >= 0xdc00 && job.tail.charCodeAt(start) <= 0xdfff) start++;
  const tail = job.tail.slice(start);
  return { version: 1, id: job.id, name: clean(job.name, 80), command: clean(job.command, 2000),
    cwd: clean(job.cwd, 2000), pty: job.pty, columns: job.columns, rows: job.rows, status: job.status, startedAt: job.startedAt,
    endedAt: job.endedAt, code: job.code, signal: job.signal,
    outputStart: job.outputEnd - tail.length, outputEnd: job.outputEnd,
    tail, error: job.error ? clean(job.error, 1000) : undefined };
}

export function decodeJob(value: unknown): JobSnapshot | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(v.id)
    || typeof v.status !== "string" || !STATUSES.has(v.status as JobStatus)
    || typeof v.name !== "string" || typeof v.command !== "string" || typeof v.cwd !== "string"
    || typeof v.tail !== "string" || typeof v.startedAt !== "number" || !Number.isFinite(v.startedAt) || v.startedAt < 0
    || typeof v.outputEnd !== "number" || !Number.isSafeInteger(v.outputEnd) || v.outputEnd < 0) return;
  if (v.endedAt !== undefined && (typeof v.endedAt !== "number" || !Number.isFinite(v.endedAt) || v.endedAt < v.startedAt)) return;
  if (!isActive(v.status as JobStatus) && v.endedAt === undefined && v.status !== "interrupted") return;
  const tail = clean(v.tail, 2000);
  return { id: v.id, name: clean(v.name, 80), command: clean(v.command, 2000), cwd: clean(v.cwd, 2000),
    pty: v.pty === true, columns: typeof v.columns === "number" && Number.isSafeInteger(v.columns) && v.columns >= 10 && v.columns <= 500 ? v.columns : undefined,
    rows: typeof v.rows === "number" && Number.isSafeInteger(v.rows) && v.rows >= 2 && v.rows <= 200 ? v.rows : undefined,
    status: v.status as JobStatus, startedAt: v.startedAt, endedAt: v.endedAt as number | undefined,
    outputStart: Math.max(0, v.outputEnd - tail.length), outputEnd: Math.max(v.outputEnd, tail.length), tail,
    code: v.code === null || typeof v.code === "number" && Number.isSafeInteger(v.code) ? v.code : undefined,
    signal: typeof v.signal === "string" ? clean(v.signal, 40) : undefined,
    error: typeof v.error === "string" ? clean(v.error, 1000) : undefined };
}

export class JobHistory {
  private jobs = new Map<string, JobSnapshot>();
  private entries: readonly unknown[] = [];
  private source: (() => readonly unknown[]) | undefined;
  get(id: string): JobSnapshot | undefined {
    const known = this.jobs.get(id);
    if (known) return known;
    // Old transcript cards can outlive the recent-jobs window. Resolve those
    // lazily from the existing session instead of duplicating every log in RAM.
    const entries = this.source?.() ?? this.entries;
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index] as { type?: string; customType?: string; data?: { id?: unknown } } | null;
      if (entry?.type !== "custom" || entry.customType !== JOB_HISTORY_ENTRY || entry.data?.id !== id) continue;
      const job = decodeJob(entry.data);
      if (job) return isActive(job.status) ? { ...job, status: "interrupted", endedAt: undefined } : job;
    }
  }
  list(): JobSnapshot[] { return [...this.jobs.values()]; }
  load(entries: readonly unknown[], source?: () => readonly unknown[]): void {
    this.entries = entries;
    this.source = source;
    this.jobs.clear();
    for (const raw of entries) {
      const entry = raw as { type?: string; customType?: string; data?: unknown } | null;
      if (entry?.type !== "custom" || entry.customType !== JOB_HISTORY_ENTRY) continue;
      const job = decodeJob(entry.data);
      if (job) this.keep(job);
    }
    for (const [id, job] of this.jobs) if (isActive(job.status)) {
      this.jobs.set(id, { ...job, status: "interrupted", endedAt: undefined });
    }
  }
  freeze(): void { this.entries = this.source?.() ?? this.entries; this.source = undefined; }
  /** Return a record once at start and once at completion, never for output events. */
  observe(job: JobSnapshot): ReturnType<typeof encodeJob> | undefined {
    const previous = this.jobs.get(job.id);
    if (isActive(job.status) && previous) return;
    if (previous && !isActive(previous.status) && previous.status === job.status && previous.endedAt === job.endedAt) return;
    const record = encodeJob(job);
    this.keep(record);
    return record;
  }
  private keep(job: JobSnapshot): void {
    this.jobs.set(job.id, job);
    while (this.jobs.size > 24) {
      const oldest = [...this.jobs.values()].find((candidate) => !isActive(candidate.status));
      this.jobs.delete(oldest?.id ?? this.jobs.keys().next().value!);
    }
  }
}
