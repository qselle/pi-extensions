import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoalCompletedEvent, GOAL_COMPLETED_EVENT } from "../goal/events.ts";
import { createGoal, setGoalStatus } from "../goal/goal.ts";
import telegramExtension from "./index.ts";
import { getTelegramService } from "./service.ts";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi";
const validEnv = {
  PI_TELEGRAM_BOT_TOKEN: TOKEN,
  PI_TELEGRAM_CHAT_ID: "123456789",
};

type Handler = (event: any, ctx: any) => any;

class MockPi {
  commands = new Map<string, any>();
  handlers = new Map<string, Handler[]>();
  eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  events = {
    on: (name: string, handler: (value: unknown) => void) => {
      const handlers = this.eventHandlers.get(name) ?? new Set();
      handlers.add(handler);
      this.eventHandlers.set(name, handlers);
      return () => handlers.delete(handler);
    },
    emit: (name: string, value: unknown) => {
      for (const handler of this.eventHandlers.get(name) ?? []) handler(value);
    },
  };
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  on(name: string, handler: Handler) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }
  async emit(name: string, event: unknown, ctx: any) {
    for (const handler of this.handlers.get(name) ?? []) await handler(event, ctx);
  }
}

function context() {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    hasUI: true,
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
    notifications,
  };
}

function completion() {
  const goal = setGoalStatus({
    ...createGoal("Deliver Telegram completion summaries", { id: "goal", now: 1 }),
    tokensUsed: 1_500,
    timeUsedMs: 61_000,
  }, "complete", 2);
  return createGoalCompletedEvent(goal, "completion", 2);
}

function success(): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}

test("suppresses the entire Telegram hub inside subagent children", () => {
  const pi = new MockPi();
  const runtime = telegramExtension(pi as any, { env: validEnv, configFile: false, isSubagentChild: true });
  expect(runtime).toBeUndefined();
  expect(pi.commands.size).toBe(0);
  expect(pi.handlers.size).toBe(0);
  expect(pi.eventHandlers.size).toBe(0);
});

test("keeps missing configuration quiet and reports malformed configuration safely", async () => {
  const disabledPi = new MockPi();
  const disabledCtx = context();
  telegramExtension(disabledPi as any, { env: {}, configFile: false });
  await disabledPi.emit("session_start", {}, disabledCtx);
  expect(disabledCtx.notifications).toHaveLength(0);
  await disabledPi.commands.get("telegram-test").handler("", disabledCtx);
  expect(disabledCtx.notifications[0]).toMatchObject({ level: "warning" });

  const invalidPi = new MockPi();
  const invalidCtx = context();
  telegramExtension(invalidPi as any, { env: { PI_TELEGRAM_BOT_TOKEN: TOKEN }, configFile: false });
  await invalidPi.emit("session_start", {}, invalidCtx);
  await invalidPi.commands.get("telegram-test").handler("", invalidCtx);
  expect(invalidCtx.notifications).toHaveLength(2);
  expect(invalidCtx.notifications.map((item) => item.message).join(" ")).not.toContain(TOKEN);
  expect(invalidCtx.notifications.at(-1)?.level).toBe("error");
});

test("registers the shared service, delivers goal events, and exposes explicit testing", async () => {
  const pi = new MockPi();
  const ctx = context();
  const bodies: any[] = [];
  const runtime = telegramExtension(pi as any, {
    env: validEnv,
    configFile: false,
    fetch: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return success();
    }) as typeof fetch,
  })!;
  await pi.emit("session_start", {}, ctx);
  expect(getTelegramService()).toBe(runtime.service);

  pi.events.emit(GOAL_COMPLETED_EVENT, completion());
  pi.events.emit(GOAL_COMPLETED_EVENT, completion());
  await runtime.notifier.drain();
  expect(bodies).toHaveLength(1);
  expect(bodies[0].text).toContain("Deliver Telegram completion summaries");
  expect(bodies[0].text).toContain("Tokens: 1.5k");
  expect(bodies[0].text).toContain("Elapsed: 1m 1s");

  await pi.commands.get("telegram-test").handler("", ctx);
  expect(bodies).toHaveLength(2);
  expect(bodies[1].text).toContain("integration test");
  expect(ctx.notifications.at(-1)).toEqual({ message: "Telegram integration test sent.", level: "info" });
  await pi.emit("session_shutdown", {}, ctx);
  expect(getTelegramService()).toBeUndefined();
});

test("loads dedicated config once per extension lifecycle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-telegram-index-"));
  const path = join(directory, "telegram.json");
  const writeConfig = (chatId: string) => {
    writeFileSync(path, JSON.stringify({ botToken: TOKEN, chatId, details: "minimal" }), { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(path, 0o600);
  };
  const create = (bodies: any[]) => {
    const pi = new MockPi();
    const runtime = telegramExtension(pi as any, {
      env: { PI_TELEGRAM_CONFIG_FILE: path },
      fetch: (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return success();
      }) as typeof fetch,
    })!;
    return { pi, runtime };
  };

  try {
    writeConfig("111111111");
    const firstBodies: any[] = [];
    const first = create(firstBodies);
    const firstContext = context();
    await first.pi.emit("session_start", {}, firstContext);
    await first.pi.commands.get("telegram-test").handler("", firstContext);
    expect(firstBodies[0].chat_id).toBe("111111111");

    writeConfig("222222222");
    await first.pi.commands.get("telegram-test").handler("", firstContext);
    expect(firstBodies[1].chat_id).toBe("111111111");
    await first.pi.emit("session_shutdown", {}, firstContext);

    const secondBodies: any[] = [];
    const second = create(secondBodies);
    const secondContext = context();
    await second.pi.emit("session_start", {}, secondContext);
    await second.pi.commands.get("telegram-test").handler("", secondContext);
    expect(secondBodies[0].chat_id).toBe("222222222");
    await second.pi.emit("session_shutdown", {}, secondContext);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("waits for pending goal delivery during session shutdown", async () => {
  const pi = new MockPi();
  const ctx = context();
  let resolveResponse!: (response: Response) => void;
  const runtime = telegramExtension(pi as any, {
    env: validEnv,
    configFile: false,
    fetch: (async () => new Promise<Response>((resolve) => { resolveResponse = resolve; })) as typeof fetch,
  })!;
  await pi.emit("session_start", {}, ctx);
  pi.events.emit(GOAL_COMPLETED_EVENT, completion());
  expect(runtime.notifier.pendingCount()).toBe(1);

  let stopped = false;
  const shutdown = pi.emit("session_shutdown", {}, ctx).then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  resolveResponse(success());
  await shutdown;
  expect(stopped).toBe(true);
  expect(runtime.notifier.pendingCount()).toBe(0);
});
