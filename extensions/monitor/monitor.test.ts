import { describe, expect, test } from "bun:test";
import {
  MONITOR_STATE_VERSION,
  applyObservation,
  completeMonitorAlert,
  createMonitor,
  decodeMonitorSnapshot,
  encodeMonitorSnapshot,
  enforceMonitorLimits,
  parseMonitorCommand,
  pauseMonitor,
  resumeMonitor,
} from "./monitor.ts";

describe("monitor state", () => {
  test("parses bounded commands and explicit wake policies", () => {
    expect(parseMonitorCommand("30s -- npm test")).toEqual({
      intervalMs: 30_000, command: "npm test", condition: "change", maxRuns: 100,
    });
    expect(parseMonitorCommand("2m --on failure --max-runs 12 -- gh pr checks")).toEqual({
      intervalMs: 120_000, command: "gh pr checks", condition: "failure", maxRuns: 12,
    });
    expect(parseMonitorCommand("5s -- echo nope")).toBeUndefined();
    expect(parseMonitorCommand("2h -- echo nope")).toBeUndefined();
    expect(parseMonitorCommand("30s --on maybe -- echo nope")).toBeUndefined();
  });

  test("change monitoring establishes a silent baseline then wakes on change", () => {
    const initial = createMonitor(parseMonitorCommand("30s -- printf ready")!, 1_000, "watch");
    const baseline = applyObservation(initial, { code: 0, killed: false, stdout: "ready", stderr: "" }, 2_000);
    expect(baseline.wake).toBe(false);
    const unchanged = applyObservation(baseline.job, { code: 0, killed: false, stdout: "ready", stderr: "" }, 3_000);
    expect(unchanged.wake).toBe(false);
    const changed = applyObservation(unchanged.job, { code: 1, killed: false, stdout: "failed", stderr: "" }, 4_000);
    expect(changed.wake).toBe(true);
    expect(changed.reason).toContain("changed");
  });

  test("failure and success policies are edge-triggered by observations", () => {
    const failure = createMonitor(parseMonitorCommand("30s --on failure -- check")!, 1_000, "failure");
    const first = applyObservation(failure, { code: 2, killed: false, stdout: "", stderr: "bad" }, 2_000);
    expect(first.wake).toBe(true);
    expect(applyObservation(first.job, { code: 2, killed: false, stdout: "", stderr: "bad" }, 3_000).wake).toBe(false);
    const success = createMonitor(parseMonitorCommand("30s --on success -- check")!, 1_000, "success");
    expect(applyObservation(success, { code: 0, killed: false, stdout: "ok", stderr: "" }, 2_000).wake).toBe(true);
  });

  test("expires a silent observation exactly at the configured run bound", () => {
    const job = createMonitor({ ...parseMonitorCommand("30s -- check")!, maxRuns: 1 }, 1_000, "once");
    const result = applyObservation(job, { code: 0, killed: false, stdout: "", stderr: "" }, 2_000);
    expect(result.job.status).toBe("expired");
    expect(result.job.nextRunAt).toBeNull();
  });

  test("retries an interrupted final alert before expiring it on settlement", () => {
    const job = createMonitor({ ...parseMonitorCommand("30s --on always -- check")!, maxRuns: 1 }, 1_000, "once-alert");
    const alert = applyObservation(job, { code: 1, killed: false, stdout: "", stderr: "failed" }, 2_000);
    expect(alert.wake).toBe(true);
    expect(alert.job.status).toBe("active");
    expect(alert.job.pendingFinalAlert?.limitReason).toContain("1-run");

    const restored = decodeMonitorSnapshot(JSON.parse(JSON.stringify(encodeMonitorSnapshot([alert.job]))))!;
    expect(enforceMonitorLimits(restored.jobs[0]!, 2_500)).toMatchObject({ status: "paused", runs: 0 });

    const paused = pauseMonitor(alert.job, "interrupted");
    expect(paused.runs).toBe(0);
    const retried = applyObservation(resumeMonitor(paused, 3_000), { code: 1, killed: false, stdout: "", stderr: "failed" }, 4_000);
    expect(retried.wake).toBe(true);
    expect(completeMonitorAlert(retried.job).status).toBe("expired");
  });

  test("round-trips validated snapshots and drops corrupt jobs", () => {
    const snapshot = encodeMonitorSnapshot([createMonitor(parseMonitorCommand("30s -- check")!, 1_000, "valid")]);
    expect(decodeMonitorSnapshot(snapshot)).toEqual(snapshot);
    expect(decodeMonitorSnapshot({ version: 9, jobs: [] })).toBeUndefined();
    expect(decodeMonitorSnapshot({ version: MONITOR_STATE_VERSION, jobs: [{ ...snapshot.jobs[0], intervalMs: 1 }] })?.jobs).toEqual([]);
  });
});
