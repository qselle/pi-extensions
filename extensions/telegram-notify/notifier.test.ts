import { expect, test } from "bun:test";
import { createGoalCompletedEvent } from "../goal/events.ts";
import { createGoal, setGoalStatus } from "../goal/goal.ts";
import type { TelegramConfig } from "./config.ts";
import { TelegramNotifier } from "./notifier.ts";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi";
const config: TelegramConfig = {
  botToken: TOKEN,
  chatId: "123456789",
  details: "summary",
};

function completion(id = "completion-1") {
  const goal = setGoalStatus({
    ...createGoal("Verify Telegram delivery", { id: "goal-1", now: 1 }),
    tokensUsed: 500,
    timeUsedMs: 2_000,
  }, "complete", 2);
  return createGoalCompletedEvent(goal, id, 2);
}

function success(messageId = 1): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });
}

test("deduplicates completion IDs and drains tracked delivery", async () => {
  let resolveResponse!: (response: Response) => void;
  let calls = 0;
  const notifier = new TelegramNotifier(config, {
    fetch: (async () => {
      calls++;
      return new Promise<Response>((resolve) => { resolveResponse = resolve; });
    }) as typeof fetch,
  });

  expect(notifier.handle(completion())).toBe(true);
  expect(notifier.handle(completion())).toBe(false);
  expect(notifier.handle({ version: 1, completionId: "invalid" })).toBe(false);
  expect(notifier.pendingCount()).toBe(1);
  expect(calls).toBe(1);

  const drained = notifier.drain();
  resolveResponse(success());
  await drained;
  expect(notifier.pendingCount()).toBe(0);
  expect(calls).toBe(1);
});

test("reports a sanitized asynchronous delivery failure", async () => {
  const failures: string[] = [];
  const notifier = new TelegramNotifier(config, {
    fetch: (async () => { throw new Error(`failed URL contained ${TOKEN}`); }) as typeof fetch,
  }, {
    onFailure: (message) => failures.push(message),
  });

  expect(notifier.handle(completion())).toBe(true);
  await notifier.drain();
  expect(failures).toEqual(["Telegram notification could not reach the service."]);
  expect(failures.join(" ")).not.toContain(TOKEN);
});

test("tracks explicit test delivery through the same lifecycle", async () => {
  const bodies: any[] = [];
  const notifier = new TelegramNotifier(config, {
    fetch: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return success(9);
    }) as typeof fetch,
  });
  await expect(notifier.sendTest()).resolves.toEqual({ messageId: 9 });
  await notifier.drain();
  expect(bodies).toHaveLength(1);
  expect(bodies[0].text).toContain("notification test");
  expect(notifier.pendingCount()).toBe(0);
});
