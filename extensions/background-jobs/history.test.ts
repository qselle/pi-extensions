import { describe, expect, test } from "bun:test";
import { JOB_HISTORY_ENTRY, JobHistory, decodeJob, encodeJob } from "./history.ts";
import type { JobSnapshot } from "./service.ts";

const job = (id = "job-1", extra: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id, name: "Build", command: "build", cwd: "/tmp", status: "running", startedAt: 100,
  outputStart: 0, outputEnd: 5, tail: "hello", ...extra,
});
const entry = (value: JobSnapshot) => ({ type: "custom", customType: JOB_HISTORY_ENTRY, data: encodeJob(value) });

describe("job history", () => {
  test("records only start and completion and restores finished state", () => {
    const history = new JobHistory();
    const start = history.observe(job())!;
    expect(history.observe(job("job-1", { status: "stopping" }))).toBeUndefined();
    const end = history.observe(job("job-1", { status: "completed", endedAt: 200 }))!;
    expect(history.observe(end)).toBeUndefined();
    history.load([entry(start), entry(end)]);
    expect(history.get("job-1")?.status).toBe("completed");
  });
  test("saved active jobs become interrupted without inventing completion times", () => {
    const history = new JobHistory();
    history.load([entry(job())]);
    expect(history.get("job-1")?.status).toBe("interrupted");
    expect(history.get("job-1")?.endedAt).toBeUndefined();
  });
  test("bounds recent history but resolves old cards from the session", () => {
    const entries = Array.from({ length: 40 }, (_, index) => entry(job(`job-${index}`, { status: "completed", endedAt: 200 })));
    const history = new JobHistory();
    let reads = 0;
    history.load(entries, () => { reads++; return entries; });
    expect(history.list()).toHaveLength(24);
    expect(history.get("job-0")?.status).toBe("completed");
    expect(reads).toBe(1);
    history.freeze();
    history.get("job-0");
    expect(reads).toBe(2);
  });
  test("recent retention never evicts an active process for finished jobs", () => {
    const history = new JobHistory();
    history.observe(job("active"));
    for (let index = 0; index < 40; index++) history.observe(job(`job-${index}`, { status: "completed", endedAt: 200 }));
    expect(history.list()).toHaveLength(24);
    expect(history.get("active")?.status).toBe("running");
  });
  test("rejects corrupt records and strips terminal controls", () => {
    const valid = encodeJob(job());
    for (const extra of [{ version: 2 }, { id: "../bad" }, { status: "unknown" }, { startedAt: NaN }, { outputEnd: -1 }, { endedAt: 10 }, { status: "completed" }]) {
      expect(decodeJob({ ...valid, ...extra })).toBeUndefined();
    }
    expect(decodeJob({ ...valid, name: "\x1b[31mBuild\x1b[0m" })?.name).toBe("Build");
    const history = new JobHistory();
    history.load([null, {}, { ...entry(job()), customType: "unrelated" }]);
    expect(history.list()).toEqual([]);
  });
  test("persists only bounded presentation fields and preserves Unicode boundaries", () => {
    const record = encodeJob({ ...job(), name: "a".repeat(79) + "😀", tail: "😀" + "x".repeat(1999), outputEnd: 2001, pid: 42, stdin: "private" } as JobSnapshot);
    expect(record.name).toBe("a".repeat(79));
    expect(record.tail).toBe("x".repeat(1999));
    expect(record.outputStart).toBe(2);
    expect(record).not.toHaveProperty("pid");
    expect(record).not.toHaveProperty("stdin");
  });
});
