import { describe, expect, test } from "bun:test";
import {
  LOOP_STATE_VERSION,
  MAX_RETAINED_LOOPS,
  beginLoopIteration,
  createLoop,
  decodeLoopSnapshot,
  encodeLoopSnapshot,
  enforceLoopLimits,
  pauseLoop,
  resumeLoop,
  scheduleDynamicFallback,
  scheduleDynamicLoop,
} from "./loop.ts";

describe("loop state", () => {
  test("advances fixed cadence without replaying missed runs", () => {
    const job = createLoop("check CI", 300_000, 1_000, "fixed");
    const running = beginLoopIteration(job, 901_000);
    expect(running.iterations).toBe(1);
    expect(running.nextRunAt).toBe(1_201_000);
  });

  test("dynamic schedules are bounded and clear fallback history", () => {
    const job = scheduleDynamicFallback(createLoop("watch CI", null, 1_000, "dynamic"), 2_000);
    expect(job.fallbackWakeups).toBe(1);
    const scheduled = scheduleDynamicLoop(job, 5_000, "build is nearly done", 3_000);
    expect(scheduled.nextRunAt).toBe(63_000);
    expect(scheduled.fallbackWakeups).toBe(0);
  });

  test("pause and resume re-arm immediately within bounds", () => {
    const job = createLoop("watch CI", null, 1_000, "resume");
    const paused = pauseLoop(job, "user paused");
    expect(paused.nextRunAt).toBeNull();
    expect(resumeLoop(paused, 5_000).nextRunAt).toBe(5_000);
  });

  test("enforces lifetime and round caps", () => {
    const job = createLoop("watch CI", null, 1_000, "limits");
    expect(enforceLoopLimits(job, job.expiresAt).status).toBe("expired");
    expect(enforceLoopLimits({ ...job, iterations: job.maxIterations }, 2_000).status).toBe("expired");
  });

  test("round-trips validated session snapshots", () => {
    const snapshot = encodeLoopSnapshot([createLoop("watch CI", null, 1_000, "snapshot")]);
    expect(decodeLoopSnapshot(snapshot)).toEqual(snapshot);
    expect(decodeLoopSnapshot({ version: 1, jobs: [{ id: "broken" }] })).toEqual({
      version: LOOP_STATE_VERSION,
      jobs: [],
    });
  });

  test("migrates valid version-one jobs to explicit prompt sources", () => {
    const legacy = createLoop("watch CI", null, 1_000, "legacy");
    const { promptSource: _, ...withoutPromptSource } = legacy;
    const decoded = decodeLoopSnapshot({ version: 1, jobs: [withoutPromptSource] });
    expect(decoded?.version).toBe(LOOP_STATE_VERSION);
    expect(decoded?.jobs[0]?.promptSource).toBe("explicit");
  });

  test("preserves version-one fixed intervals above the new creation cap", () => {
    const legacy = createLoop("watch CI", 3_600_000, 1_000, "legacy-fixed");
    const { promptSource: _, ...withoutPromptSource } = { ...legacy, intervalMs: 2 * 3_600_000 };
    const decoded = decodeLoopSnapshot({ version: 1, jobs: [withoutPromptSource] });
    expect(decoded?.jobs[0]?.intervalMs).toBe(2 * 3_600_000);
  });

  test("retains every live loop before recent terminal history", () => {
    const live = createLoop("important active loop", null, 1_000, "live");
    const terminal = Array.from({ length: MAX_RETAINED_LOOPS + 6 }, (_, index) => ({
      ...createLoop(`terminal ${index}`, null, index + 2_000, `old-${index}`),
      status: "stopped" as const,
      nextRunAt: null,
    }));
    const snapshot = encodeLoopSnapshot([...terminal, live]);
    expect(snapshot.jobs).toHaveLength(MAX_RETAINED_LOOPS);
    expect(snapshot.jobs.some((job) => job.id === "live")).toBe(true);
    expect(snapshot.jobs.filter((job) => job.status === "active")).toHaveLength(1);
    expect(snapshot.jobs.at(-1)?.id).toBe(`old-${terminal.length - (MAX_RETAINED_LOOPS - 1)}`);
  });

  test("rejects corrupt state rather than scheduling it", () => {
    const job = createLoop("watch CI", null, 1_000, "valid");
    expect(decodeLoopSnapshot({ version: 999, jobs: [job] })).toBeUndefined();
    expect(decodeLoopSnapshot({ version: LOOP_STATE_VERSION, jobs: [{ ...job, nextRunAt: Number.NaN }] })?.jobs).toEqual([]);
    expect(decodeLoopSnapshot({ version: LOOP_STATE_VERSION, jobs: [{ ...job, fallbackWakeups: 9 }] })?.jobs).toEqual([]);
  });
});
