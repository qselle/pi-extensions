import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoalCompletedEvent, GOAL_COMPLETED_EVENT } from "../goal/events.ts";
import { createGoal, setGoalStatus } from "../goal/goal.ts";
import { loadTelegramConfig } from "./config.ts";
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
  tools = new Map<string, any>();
  activeTools = ["read", "bash"];
  handlers = new Map<string, Handler[]>();
  eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  forwardedMessages: unknown[] = [];
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
  registerTool(tool: any) { this.tools.set(tool.name, tool); this.activeTools.push(tool.name); }
  getActiveTools() { return this.activeTools; }
  setActiveTools(tools: string[]) { this.activeTools = tools; }
  sendMessage(message: unknown) { this.forwardedMessages.push(message); }
  sendUserMessage(message: unknown) { this.forwardedMessages.push(message); }
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
  expect(pi.tools.size).toBe(0);
  expect(pi.handlers.size).toBe(0);
  expect(pi.eventHandlers.size).toBe(0);
});

test("keeps missing configuration quiet and reports malformed configuration safely", async () => {
  const disabledPi = new MockPi();
  const disabledCtx = context();
  telegramExtension(disabledPi as any, { env: {}, configFile: false });
  await disabledPi.emit("session_start", {}, disabledCtx);
  expect(disabledCtx.notifications).toHaveLength(0);
  expect(disabledPi.activeTools).toEqual(["read", "bash"]);
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

test("sets up, reports, disables, and re-enables Telegram without reload", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-telegram-setup-"));
  const path = join(directory, "telegram.json");
  const pi = new MockPi();
  const ctx = context() as any;
  ctx.mode = "tui";
  ctx.cwd = "/tmp/project";
  ctx.ui.custom = async () => TOKEN;
  const inputs = ["987654321", "0.25"];
  ctx.ui.input = async () => inputs.shift();
  const bodies: any[] = [];

  try {
    expect(telegramExtension(pi as any, {
      env: {},
      configFile: path,
      fetch: (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return success();
      }),
    })).toBeUndefined();
    await pi.emit("session_start", {}, ctx);

    await pi.commands.get("telegram").handler("setup", ctx);
    expect(getTelegramService()).toBeDefined();
    expect(pi.activeTools).toEqual(["read", "bash", "notify_user"]);
    expect(loadTelegramConfig({ env: {}, configFile: path })).toMatchObject({
      status: "enabled",
      config: { botToken: TOKEN, chatId: "987654321", questionDelayMinutes: 0.25 },
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      botToken: TOKEN,
      chatId: "987654321",
      enabled: true,
    });
    expect(pi.forwardedMessages).toEqual([]);
    expect(bodies[0].text).toContain("setup test");
    expect(ctx.notifications.at(-1)).toEqual({
      message: "Telegram configured and enabled; test message sent.",
      level: "info",
    });

    await pi.commands.get("telegram").handler("status", ctx);
    expect(ctx.notifications.at(-1).message).toContain("15 seconds");
    await pi.commands.get("telegram").handler("off", ctx);
    expect(getTelegramService()).toBeUndefined();
    expect(pi.activeTools).toEqual(["read", "bash"]);
    expect(loadTelegramConfig({ env: {}, configFile: path }).status).toBe("disabled");
    await pi.commands.get("telegram").handler("on", ctx);
    expect(getTelegramService()).toBeDefined();
    expect(pi.activeTools).toEqual(["read", "bash", "notify_user"]);
    expect(loadTelegramConfig({ env: {}, configFile: path }).status).toBe("enabled");

    await pi.commands.get("telegram").handler("test", ctx);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].text).toContain("integration test");
    expect(JSON.stringify(ctx.notifications)).not.toContain(TOKEN);
    await pi.emit("session_shutdown", {}, ctx);
    expect(getTelegramService()).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
    }),
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
      }),
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
    fetch: (async () => new Promise<Response>((resolve) => { resolveResponse = resolve; })),
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

test("explicit command and tool send formatted notifications through the shared destination", async () => {
  const pi = new MockPi();
  const ctx = context();
  const bodies: any[] = [];
  telegramExtension(pi as any, { env: { ...validEnv, PI_TELEGRAM_THREAD_ID: "42" }, configFile: false, fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return success();
  } });
  await pi.emit("session_start", {}, ctx);
  const command = pi.commands.get("telegram");
  await command.handler("send **Ready**\n\nReport available.", ctx);
  expect(ctx.notifications.at(-1)?.message).toBe("Telegram notification sent.");
  const result = await pi.tools.get("notify_user").execute("id", { message: "# Complete\n\n[Report](https://example.com)" }, undefined, undefined, ctx);
  expect(result.details).toEqual({ sent: true, messageId: 1 });
  expect(result.isError).not.toBe(true);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject({ text: "<b>Ready</b>\n\nReport available.", parse_mode: "HTML", message_thread_id: 42, chat_id: validEnv.PI_TELEGRAM_CHAT_ID, disable_web_page_preview: true });
  expect(bodies[1].text).toContain("<b>Complete</b>");
  expect(command.getArgumentCompletions("do")).toEqual([{ value: "doctor", label: "doctor" }]);
  expect(pi.forwardedMessages).toEqual([]);
  await pi.emit("session_shutdown", {}, ctx);
});

test("disabled integration and invalid direct messages never contact Telegram", async () => {
  let calls = 0;
  const pi = new MockPi();
  const ctx = context();
  telegramExtension(pi as any, { env: {}, configFile: false, fetch: async () => { calls++; return success(); } });
  await pi.commands.get("telegram").handler("doctor", ctx);
  await pi.commands.get("telegram").handler("send Hello", ctx);
  const result = await pi.tools.get("notify_user").execute("id", { message: "Hello" }, undefined, undefined, ctx);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("not enabled");
  expect(calls).toBe(0);
  await pi.emit("session_shutdown", {}, ctx);

  const enabledPi = new MockPi();
  telegramExtension(enabledPi as any, { env: validEnv, configFile: false, fetch: async () => { calls++; return success(); } });
  await enabledPi.commands.get("telegram").handler("send", ctx);
  await enabledPi.commands.get("telegram").handler(`send ${"a".repeat(4097)}`, ctx);
  expect(ctx.notifications.at(-1)?.message).toContain("4096");
  expect(calls).toBe(0);
  await enabledPi.emit("session_shutdown", {}, ctx);
});

test("session startup respects a manually narrowed active tool list", async () => {
  const pi = new MockPi();
  const ctx = context();
  telegramExtension(pi as any, { env: validEnv, configFile: false });
  pi.activeTools = ["read"];
  await pi.emit("session_start", {}, ctx);
  expect(pi.activeTools).toEqual(["read"]);
  await pi.emit("session_shutdown", {}, ctx);
});

test("tool failures are sanitized and unconfirmed delivery is never retried automatically", async () => {
  for (const failure of ["network", "unconfirmed", "rejected"]) {
    const pi = new MockPi();
    const ctx = context();
    let calls = 0;
    telegramExtension(pi as any, { env: validEnv, configFile: false, fetch: async () => {
      calls++;
      if (failure === "network") throw new Error(`secret ${TOKEN}`);
      return failure === "unconfirmed" ? Response.json({ ok: true, result: {} }) : Response.json({ ok: false, description: TOKEN }, { status: 403 });
    } });
    const result = await pi.tools.get("notify_user").execute("id", { message: "Hello" }, undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(result.details.sent).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    if (failure !== "rejected") expect(result.content[0].text.toLowerCase()).toContain("check the chat before retrying");
    expect(calls).toBe(1);
    await pi.emit("session_shutdown", {}, ctx);
  }
});

test("cancelling an in-flight notification warns about unconfirmed delivery", async () => {
  const pi = new MockPi();
  const ctx = context();
  const controller = new AbortController();
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  telegramExtension(pi as any, { env: validEnv, configFile: false, fetch: async (_url, init) => {
    calls++;
    started();
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  } });
  const response = pi.tools.get("notify_user").execute("id", { message: "Hello" }, controller.signal, undefined, ctx);
  await pending;
  controller.abort();
  const result = await response;
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("cancelled");
  expect(result.content[0].text).toContain("check the chat before retrying");
  expect(calls).toBe(1);
  await pi.emit("session_shutdown", {}, ctx);
});

test("doctor command performs only read-only checks and leaves the bot untouched", async () => {
  const pi = new MockPi();
  const ctx = context();
  const calls: string[] = [];
  telegramExtension(pi as any, { env: validEnv, configFile: false, fetch: async (url) => {
    const method = String(url).split("/").at(-1)!;
    calls.push(method);
    const result = method === "getMe" ? { id: 123456789, is_bot: true, has_topics_enabled: true }
      : method === "getChat" ? { type: "private" } : { url: "https://example.com/private-hook" };
    return Response.json({ ok: true, result });
  } });
  await pi.commands.get("telegram").handler("doctor", ctx);
  expect(calls.sort()).toEqual(["getChat", "getMe", "getWebhookInfo"]);
  expect(ctx.notifications.at(-1)?.level).toBe("error");
  expect(ctx.notifications.at(-1)?.message).toContain("webhook blocks");
  expect(ctx.notifications.at(-1)?.message).not.toContain("private-hook");
  await pi.emit("session_shutdown", {}, ctx);
});
