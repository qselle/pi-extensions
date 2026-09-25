import { expect, test } from "bun:test";
import { createGoalCompletedEvent } from "../goal/events.ts";
import { createGoal, setGoalStatus } from "../goal/goal.ts";
import type { TelegramService } from "./service.ts";
import { TelegramNotifier } from "./notifier.ts";
import type { MonitorAlertEvent } from "../monitor/events.ts";

function completion(id = "completion-1") {
  const goal = setGoalStatus({
    ...createGoal("Verify Telegram delivery", { id: "goal-1", now: 1 }),
    tokensUsed: 500,
    timeUsedMs: 2_000,
  }, "complete", 2);
  return createGoalCompletedEvent(goal, id, 2);
}

function fakeService(send: TelegramService["send"]): TelegramService {
  return {
    send,
    openPrompt: async () => { throw new Error("unused"); },
    drain: async () => undefined,
    shutdown: async () => undefined,
  };
}

test("deduplicates completion IDs and drains tracked delivery", async () => {
  let resolveSend!: (value: { messageId: number }) => void;
  let calls = 0;
  const notifier = new TelegramNotifier(fakeService(async () => {
    calls++;
    return new Promise((resolve) => { resolveSend = resolve as typeof resolveSend; });
  }), "summary");

  expect(notifier.handle(completion())).toBe(true);
  expect(notifier.handle(completion())).toBe(false);
  expect(notifier.handle({ version: 1, completionId: "invalid" })).toBe(false);
  expect(notifier.pendingCount()).toBe(1);
  expect(calls).toBe(1);

  const drained = notifier.drain();
  resolveSend({ messageId: 1 });
  await drained;
  expect(notifier.pendingCount()).toBe(0);
  expect(calls).toBe(1);
});

test("reports a sanitized asynchronous delivery failure", async () => {
  const failures: string[] = [];
  const notifier = new TelegramNotifier(fakeService(async () => {
    throw new Error("sensitive failure");
  }), "summary", {
    onFailure: (message) => failures.push(message),
  });

  expect(notifier.handle(completion())).toBe(true);
  await notifier.drain();
  expect(failures).toEqual(["Telegram request failed unexpectedly."]);
  expect(failures.join(" ")).not.toContain("sensitive failure");
});

test("tracks explicit test delivery through the shared service", async () => {
  const messages: string[] = [];
  const notifier = new TelegramNotifier(fakeService(async (text) => {
    messages.push(text);
    return { messageId: 9 };
  }), "summary");
  await expect(notifier.sendTest()).resolves.toEqual({ messageId: 9 });
  await notifier.drain();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("integration test");
  expect(notifier.pendingCount()).toBe(0);
});

test("monitor alerts are deduplicated, bounded metadata without logs or commands", async () => {
  const messages: string[] = [];
  const notifier = new TelegramNotifier(fakeService(async (message) => {
    messages.push(message); return { messageId: messages.length };
  }), "full");
  const event = {
    version: 1, alertId: "ci:1", sessionId: "session", monitorId: "ci", kind: "result", condition: "change",
    runs: 1, maxRuns: 20, exitCode: 1, killed: false,
  } satisfies MonitorAlertEvent;
  expect(notifier.handleMonitor({ ...event, command: "private command", stdout: "private output" })).toBe(true);
  expect(notifier.handleMonitor(event)).toBe(false);
  expect(notifier.handleMonitor({ ...event, alertId: "invalid", monitorId: "bad\nfield" })).toBe(false);
  expect(notifier.handleMonitor({ ...event, alertId: "invalid", runs: 21 })).toBe(false);
  expect(notifier.handleMonitor({ ...event, alertId: "ci:1:paused", kind: "agent_failed" })).toBe(true);
  await notifier.drain();
  expect(messages).toHaveLength(2);
  expect(messages[0]).toContain("Result changed · Exit 1");
  expect(messages[1]).toContain("Monitoring paused");
  expect(messages.join("\n")).not.toContain("private");
});

test("monitor delivery failures are sanitized and drained without duplicate retries", async () => {
  const failures: string[] = [];
  let calls = 0;
  const notifier = new TelegramNotifier(fakeService(async () => {
    calls++; throw new Error("private request");
  }), "summary", { onFailure: (message) => failures.push(message) });
  const event: MonitorAlertEvent = { version: 1, alertId: "a", sessionId: "session", monitorId: "m", kind: "wakeup_failed", condition: "success", runs: 1, maxRuns: 2, exitCode: 0, killed: false };
  notifier.handleMonitor(event);
  await notifier.drain();
  expect(notifier.handleMonitor(event)).toBe(false);
  expect(calls).toBe(1);
  expect(failures).toEqual(["Telegram request failed unexpectedly."]);
});

test("goal and schedule attention validates status metadata and never formats extra task data", async () => {
  const messages: string[] = [];
  const notifier = new TelegramNotifier(fakeService(async (text) => { messages.push(text); return { messageId: 1 }; }), "full");
  const goal = { version: 1, attentionId: "goal-warning", sessionId: "session", goalId: "goal", status: "blocked", turns: 3, tokensUsed: 100, tokenBudget: null, objective: "private objective", blocker: "private blocker" };
  expect(notifier.handleGoalAttention(goal)).toBe(true);
  expect(notifier.handleGoalAttention(goal)).toBe(false);
  expect(notifier.handleGoalAttention({ ...goal, attentionId: "invalid", status: "paused" })).toBe(false);
  expect(notifier.handleGoalAttention({ ...goal, attentionId: "invalid", goalId: "invalid\nfield" })).toBe(false);
  const schedule = { version: 1, attentionId: "schedule-warning", sessionId: "session", kind: "queue_failed", prompt: "private prompt", path: "private path", error: "private error" };
  expect(notifier.handleSchedule(schedule)).toBe(true);
  expect(notifier.handleSchedule(schedule)).toBe(false);
  expect(notifier.handleSchedule({ ...schedule, attentionId: "invalid", taskId: 123, taskKind: "cron" })).toBe(false);
  expect(notifier.handleSchedule({ ...schedule, attentionId: "invalid", kind: "completed" })).toBe(false);
  await notifier.drain();
  expect(messages).toHaveLength(2);
  expect(messages.join("\n")).not.toContain("private");
});
