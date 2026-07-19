import { expect, test } from "bun:test";
import { createGoalCompletedEvent } from "../goal/events.ts";
import { createGoal, setGoalStatus } from "../goal/goal.ts";
import type { TelegramService } from "./service.ts";
import { TelegramNotifier } from "./notifier.ts";

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
