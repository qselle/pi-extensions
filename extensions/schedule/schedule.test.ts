import { describe, expect, test } from "bun:test";
import {
  SCHEDULE_STORE_VERSION,
  completeDelivery,
  createCronTask,
  createReminder,
  decodeScheduleStore,
  markDeliveryPending,
  parseCronCommand,
  parseReminderCommand,
  pauseTask,
  resumeTask,
} from "./schedule.ts";

describe("persistent schedules", () => {
  test("parses one-shot durations and absolute timestamps", () => {
    const now = Date.parse("2026-08-08T10:00:00Z");
    expect(parseReminderCommand("in 30m -- check the deploy", now)).toEqual({ prompt: "check the deploy", runAt: now + 1_800_000 });
    expect(parseReminderCommand("2h -- check CI", now)).toEqual({ prompt: "check CI", runAt: now + 7_200_000 });
    expect(parseReminderCommand("at 2026-08-09T12:00:00Z -- send a report", now)).toEqual({
      prompt: "send a report", runAt: Date.parse("2026-08-09T12:00:00Z"),
    });
    expect(parseReminderCommand("at 09/10/2026 -- ambiguous", now)).toBeUndefined();
    expect(parseReminderCommand("at 2026-02-30T12:00:00Z -- invalid date", now)).toBeUndefined();
    expect(parseReminderCommand("at 2026-08-09T12:00:00 -- missing offset", now)).toBeUndefined();
    expect(parseReminderCommand("30s -- too soon", now)).toBeUndefined();
  });

  test("parses timezone and bounds for cron prompts", () => {
    expect(parseCronCommand("0 9 * * MON-FRI --tz Europe/Berlin --max-runs 12 -- review CI")).toEqual({
      expression: "0 9 * * MON-FRI", timeZone: "Europe/Berlin", maxRuns: 12, prompt: "review CI",
    });
    expect(parseCronCommand("0 25 * * * -- invalid")).toBeUndefined();
    expect(parseCronCommand("0 9 * * * --tz Nope/Here -- invalid")).toBeUndefined();
  });

  test("keeps delivery pending until a turn settles", () => {
    const task = createReminder({ prompt: "check deploy", runAt: 2_000 }, 1_000, "remind");
    const pending = markDeliveryPending(task);
    expect(pending.pendingDeliveryAt).toBe(2_000);
    const completed = completeDelivery(pending, 3_000);
    expect(completed.status).toBe("completed");
    expect(completed.runs).toBe(1);
    expect(completed.lastScheduledFor).toBe(2_000);
  });

  test("preserves a pending delivery across pause and resume", () => {
    const task = markDeliveryPending(createReminder({ prompt: "check deploy", runAt: 2_000 }, 1_000, "retry"));
    const resumed = resumeTask(pauseTask(task, "interrupted"), 5_000);
    expect(resumed.status).toBe("active");
    expect(resumed.nextRunAt).toBe(5_000);
    expect(resumed.pendingDeliveryAt).toBe(2_000);
  });

  test("advances cron without replaying missed intervals", () => {
    const task = createCronTask({ prompt: "daily", expression: "0 9 * * *", timeZone: "UTC", maxRuns: 3 }, Date.parse("2026-08-08T08:00:00Z"), "daily");
    const delivered = completeDelivery(markDeliveryPending(task), Date.parse("2026-08-10T12:00:00Z"));
    expect(new Date(delivered.nextRunAt!).toISOString()).toBe("2026-08-11T09:00:00.000Z");
    expect(delivered.runs).toBe(1);
  });

  test("validates persisted tasks for the expected project", () => {
    const project = "/tmp/project";
    const task = createReminder({ prompt: "check", runAt: 2_000 }, 1_000, "valid");
    expect(decodeScheduleStore({ version: SCHEDULE_STORE_VERSION, projectCwd: project, tasks: [task] }, project)?.tasks).toHaveLength(1);
    expect(decodeScheduleStore({ version: SCHEDULE_STORE_VERSION, projectCwd: "/other", tasks: [task] }, project)).toBeUndefined();
    expect(decodeScheduleStore({ version: SCHEDULE_STORE_VERSION, projectCwd: project, tasks: [{ ...task, prompt: "" }] }, project)).toBeUndefined();
  });
});
