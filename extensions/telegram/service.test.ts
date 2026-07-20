import { expect, test } from "bun:test";
import type { TelegramConfig } from "./config.ts";
import {
  DefaultTelegramService,
  getTelegramService,
  registerTelegramService,
  type TelegramService,
} from "./service.ts";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi";
const config: TelegramConfig = {
  botToken: TOKEN,
  chatId: "-1001234567890",
  threadId: 42,
  details: "summary",
  questionDelayMinutes: 5,
};

function response(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function methodOf(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

function parser(text: string) {
  return text === "valid"
    ? { status: "accepted" as const, value: "accepted", displayText: "valid" }
    : { status: "rejected" as const, message: "Try again" };
}

test("registers one optional global Telegram service with owner-safe cleanup", () => {
  const first = {} as TelegramService;
  const second = {} as TelegramService;
  const firstHandle = registerTelegramService(first);
  expect(getTelegramService()).toBe(first);
  const secondHandle = registerTelegramService(second);
  expect(getTelegramService()).toBe(second);
  firstHandle.unregister();
  expect(getTelegramService()).toBe(second);
  secondHandle.unregister();
  expect(getTelegramService()).toBeUndefined();
});

test("routes only exact prompt replies through one central polling cursor", async () => {
  const requests: Array<{ method: string; body: any }> = [];
  let updatesCalls = 0;
  const service = new DefaultTelegramService(config, {
    emptyPollDelayMs: 0,
    fetch: (async (url, init) => {
      const method = methodOf(String(url));
      const body = JSON.parse(String(init?.body));
      requests.push({ method, body });
      if (method === "sendMessage") {
        const sends = requests.filter((request) => request.method === "sendMessage").length;
        return response({ message_id: sends === 1 ? 50 : 60 + sends });
      }
      updatesCalls++;
      if (updatesCalls === 1) return response([{ update_id: 9 }]);
      return response([
        { update_id: 10, message: { message_id: 70, text: "valid", chat: { id: -999 }, reply_to_message: { message_id: 50 } } },
        { update_id: 11, message: { message_id: 71, text: "invalid", chat: { id: -1001234567890 }, message_thread_id: 42, reply_to_message: { message_id: 50 } } },
        { update_id: 12, message: { message_id: 72, text: "valid", chat: { id: -1001234567890 }, message_thread_id: 42, reply_to_message: { message_id: 50 } } },
      ]);
    }) as typeof fetch,
  });

  const prompt = await service.openPrompt({ text: "Question", parse: parser });
  expect(await prompt.result).toEqual({ status: "answered", value: "accepted" });
  await service.drain();

  expect(requests[0]).toEqual({
    method: "getUpdates",
    body: { offset: -1, timeout: 0, allowed_updates: ["message", "callback_query"] },
  });
  expect(requests[1].body).toMatchObject({
    text: "Question",
    message_thread_id: 42,
    reply_markup: { force_reply: true },
  });
  expect(requests[2]).toEqual({
    method: "getUpdates",
    body: { offset: 10, timeout: 20, allowed_updates: ["message", "callback_query"] },
  });
  expect(requests.some((request) => request.body.text === "Try again")).toBe(true);
  expect(requests.some((request) => String(request.body.text).includes("Reply received first on Telegram"))).toBe(true);
  await service.shutdown();
});

test("shares one long poll across concurrent prompts", async () => {
  let sendId = 100;
  let activePolls = 0;
  let maxActivePolls = 0;
  let resolvePoll!: (response: Response) => void;
  const pollResponse = new Promise<Response>((resolve) => { resolvePoll = resolve; });
  const service = new DefaultTelegramService(config, {
    emptyPollDelayMs: 0,
    fetch: (async (url, init) => {
      const method = methodOf(String(url));
      const body = JSON.parse(String(init?.body));
      if (method === "sendMessage") return response({ message_id: sendId++ });
      if (body.offset === -1) return response([]);
      activePolls++;
      maxActivePolls = Math.max(maxActivePolls, activePolls);
      return pollResponse.finally(() => { activePolls--; });
    }) as typeof fetch,
  });

  const first = await service.openPrompt({ text: "First", parse: parser });
  const second = await service.openPrompt({ text: "Second", parse: parser });
  resolvePoll(response([
    { update_id: 1, message: { message_id: 201, text: "valid", chat: { id: -1001234567890 }, message_thread_id: 42, reply_to_message: { message_id: first.messageId } } },
    { update_id: 2, message: { message_id: 202, text: "valid", chat: { id: -1001234567890 }, message_thread_id: 42, reply_to_message: { message_id: second.messageId } } },
  ]));

  expect(await first.result).toEqual({ status: "answered", value: "accepted" });
  expect(await second.result).toEqual({ status: "answered", value: "accepted" });
  expect(maxActivePolls).toBe(1);
  await service.shutdown();
});

test("routes exact callback choices, acknowledges stale buttons, and removes controls", async () => {
  const requests: Array<{ method: string; body: any }> = [];
  let updatesCalls = 0;
  const service = new DefaultTelegramService(config, {
    emptyPollDelayMs: 0,
    fetch: (async (url, init) => {
      const method = methodOf(String(url));
      const body = JSON.parse(String(init?.body));
      requests.push({ method, body });
      if (method === "sendMessage") return response({ message_id: 50 });
      if (method === "answerCallbackQuery" || method === "editMessageReplyMarkup") return response(true);
      updatesCalls++;
      if (updatesCalls === 1) return response([{ update_id: 9 }]);
      return response([
        {
          update_id: 10,
          callback_query: {
            id: "wrong-chat",
            data: "choice:0",
            message: { message_id: 50, message_thread_id: 42, chat: { id: -999 } },
          },
        },
        {
          update_id: 11,
          callback_query: {
            id: "wrong-topic",
            data: "choice:0",
            message: { message_id: 50, message_thread_id: 7, chat: { id: -1001234567890 } },
          },
        },
        {
          update_id: 12,
          callback_query: {
            id: "invalid-choice",
            data: "choice:9",
            message: { message_id: 50, message_thread_id: 42, chat: { id: -1001234567890 } },
          },
        },
        {
          update_id: 13,
          callback_query: {
            id: "valid-choice",
            data: "choice:1",
            message: { message_id: 50, message_thread_id: 42, chat: { id: -1001234567890 } },
          },
        },
        {
          update_id: 14,
          callback_query: {
            id: "stale-choice",
            data: "choice:0",
            message: { message_id: 50, message_thread_id: 42, chat: { id: -1001234567890 } },
          },
        },
      ]);
    }) as typeof fetch,
  });

  const prompt = await service.openPrompt<string>({
    text: "Deploy where?",
    choices: [
      { label: "Staging", value: "staging", displayText: "Staging" },
      { label: "Production", value: "production", displayText: "Production" },
    ],
    parse: parser,
  });
  expect(await prompt.result).toEqual({ status: "answered", value: "production" });
  await service.drain();

  const promptSend = requests.find((request) => request.method === "sendMessage" && request.body.text === "Deploy where?");
  expect(promptSend?.body.reply_markup).toEqual({
    inline_keyboard: [
      [{ text: "Staging", callback_data: "choice:0" }],
      [{ text: "Production", callback_data: "choice:1" }],
    ],
  });
  const acknowledgements = requests
    .filter((request) => request.method === "answerCallbackQuery")
    .map((request) => request.body);
  expect(acknowledgements).toEqual([
    { callback_query_id: "invalid-choice", text: "This option is no longer available." },
    { callback_query_id: "valid-choice", text: "Selected: Production" },
    { callback_query_id: "stale-choice", text: "This option is no longer available." },
  ]);
  expect(requests.some((request) => request.method === "editMessageReplyMarkup" && request.body.message_id === 50)).toBe(true);
  expect(requests.some((request) => request.method === "sendMessage" && String(request.body.text).includes("Production"))).toBe(true);
  await service.shutdown();
});

test("keeps direct freeform replies available for choice prompts", async () => {
  const requests: Array<{ method: string; body: any }> = [];
  let updatesCalls = 0;
  const service = new DefaultTelegramService(config, {
    emptyPollDelayMs: 0,
    fetch: (async (url, init) => {
      const method = methodOf(String(url));
      const body = JSON.parse(String(init?.body));
      requests.push({ method, body });
      if (method === "sendMessage") return response({ message_id: 85 });
      if (method === "editMessageReplyMarkup") return response(true);
      updatesCalls++;
      if (updatesCalls === 1) return response([]);
      return response([{
        update_id: 1,
        message: {
          message_id: 86,
          text: "custom destination",
          chat: { id: -1001234567890 },
          message_thread_id: 42,
          reply_to_message: { message_id: 85 },
        },
      }]);
    }) as typeof fetch,
  });

  const prompt = await service.openPrompt<string>({
    text: "Choose or type",
    choices: [{ label: "Staging", value: "staging", displayText: "Staging" }],
    parse: (text) => ({ status: "accepted", value: text, displayText: text }),
  });
  expect(await prompt.result).toEqual({ status: "answered", value: "custom destination" });
  await service.drain();
  expect(requests.some((request) => request.method === "editMessageReplyMarkup")).toBe(true);
  expect(requests.some((request) => request.method === "sendMessage" && String(request.body.text).includes("custom destination"))).toBe(true);
  await service.shutdown();
});

test("keeps direct reply cancellation available for choice prompts", async () => {
  const requests: Array<{ method: string; body: any }> = [];
  let updatesCalls = 0;
  const service = new DefaultTelegramService(config, {
    emptyPollDelayMs: 0,
    fetch: (async (url, init) => {
      const method = methodOf(String(url));
      const body = JSON.parse(String(init?.body));
      requests.push({ method, body });
      if (method === "sendMessage") return response({ message_id: 90 });
      if (method === "editMessageReplyMarkup") return response(true);
      updatesCalls++;
      if (updatesCalls === 1) return response([]);
      return response([{
        update_id: 1,
        message: {
          message_id: 91,
          text: "/cancel",
          chat: { id: -1001234567890 },
          message_thread_id: 42,
          reply_to_message: { message_id: 90 },
        },
      }]);
    }) as typeof fetch,
  });

  const prompt = await service.openPrompt<string>({
    text: "Choose",
    choices: [{ label: "A", value: "A", displayText: "A" }],
    parse: parser,
  });
  expect(await prompt.result).toEqual({ status: "cancelled" });
  await service.drain();
  expect(requests.some((request) => request.method === "editMessageReplyMarkup")).toBe(true);
  expect(requests.some((request) => request.method === "sendMessage" && String(request.body.text).includes("cancelled from Telegram"))).toBe(true);
  await service.shutdown();
});

test("clears choice controls when a pending prompt is aborted", async () => {
  const cleared: any[] = [];
  const controller = new AbortController();
  const service = new DefaultTelegramService(config, {
    emptyPollDelayMs: 0,
    fetch: (async (url, init) => {
      const method = methodOf(String(url));
      const body = JSON.parse(String(init?.body));
      if (method === "sendMessage") return response({ message_id: 95 });
      if (method === "editMessageReplyMarkup") {
        cleared.push(body);
        return response(true);
      }
      if (body.offset === -1) return response([]);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as typeof fetch,
  });

  const prompt = await service.openPrompt<string>({
    text: "Choose",
    choices: [{ label: "A", value: "A", displayText: "A" }],
    parse: parser,
  }, controller.signal);
  controller.abort();
  expect(await prompt.result).toEqual({ status: "unavailable" });
  await service.drain();
  expect(cleared).toHaveLength(1);
  await service.shutdown();
});

test("mirrors a terminal winner back to Telegram and closes remote waiting", async () => {
  const sent: any[] = [];
  const cleared: any[] = [];
  const service = new DefaultTelegramService(config, {
    emptyPollDelayMs: 0,
    fetch: (async (url, init) => {
      const method = methodOf(String(url));
      const body = JSON.parse(String(init?.body));
      if (method === "sendMessage") {
        sent.push(body);
        return response({ message_id: sent.length === 1 ? 80 : 81 });
      }
      if (method === "editMessageReplyMarkup") {
        cleared.push(body);
        return response(true);
      }
      if (body.offset === -1) return response([]);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as typeof fetch,
  });

  const prompt = await service.openPrompt({
    text: "Question",
    choices: [{ label: "Choice", value: "accepted", displayText: "Choice" }],
    parse: parser,
  });
  await prompt.close({ status: "answered", source: "terminal", displayText: "Terminal answer" });
  expect(await prompt.result).toEqual({ status: "unavailable" });
  expect(sent.at(-1)).toMatchObject({
    text: expect.stringContaining("Terminal answer"),
    reply_parameters: { message_id: prompt.messageId },
  });
  expect(cleared).toEqual([{
    chat_id: "-1001234567890",
    message_id: prompt.messageId,
    reply_markup: { inline_keyboard: [] },
  }]);
  await service.shutdown();
});

test("sends passive cards without polling and edits the original card on terminal resolution", async () => {
  const requests: Array<{ method: string; body: any }> = [];
  const delayedConfig = { ...config, questionDelayMinutes: 0.25 };
  const service = new DefaultTelegramService(delayedConfig, {
    fetch: (async (url, init) => {
      const method = methodOf(String(url));
      const body = JSON.parse(String(init?.body));
      requests.push({ method, body });
      if (method === "sendMessage") return response({ message_id: 301 });
      if (method === "editMessageText") return response(true);
      throw new Error(`unexpected ${method}`);
    }) as typeof fetch,
  });

  expect(service.questionDelayMs).toBe(15_000);
  const prompt = await service.openPrompt<string>({
    text: "<b>Secret input needed</b>",
    parseMode: "HTML",
    interactive: false,
    formatResolved: (resolution) => resolution.status === "answered"
      ? "<b>Answered securely in Pi</b>"
      : "<b>Cancelled in Pi</b>",
    parse: () => ({ status: "rejected", message: "terminal only" }),
  });
  expect(await prompt.result).toEqual({ status: "unavailable" });
  await prompt.close({ status: "answered", source: "terminal", displayText: "[secret provided]" });
  await service.drain();

  expect(requests).toEqual([
    {
      method: "sendMessage",
      body: {
        chat_id: "-1001234567890",
        text: "<b>Secret input needed</b>",
        disable_web_page_preview: true,
        message_thread_id: 42,
        parse_mode: "HTML",
      },
    },
    {
      method: "editMessageText",
      body: {
        chat_id: "-1001234567890",
        message_id: 301,
        text: "<b>Answered securely in Pi</b>",
        disable_web_page_preview: true,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      },
    },
  ]);
  await service.shutdown();
});

test("edits an interactive card in place when Telegram wins", async () => {
  const requests: Array<{ method: string; body: any }> = [];
  let updatesCalls = 0;
  const service = new DefaultTelegramService(config, {
    emptyPollDelayMs: 0,
    fetch: (async (url, init) => {
      const method = methodOf(String(url));
      const body = JSON.parse(String(init?.body));
      requests.push({ method, body });
      if (method === "sendMessage") return response({ message_id: 311 });
      if (method === "editMessageText") return response(true);
      updatesCalls++;
      if (updatesCalls === 1) return response([]);
      return response([{
        update_id: 1,
        message: {
          message_id: 312,
          text: "valid",
          chat: { id: -1001234567890 },
          message_thread_id: 42,
          reply_to_message: { message_id: 311 },
        },
      }]);
    }) as typeof fetch,
  });

  const prompt = await service.openPrompt({
    text: "<b>Input needed</b>",
    parseMode: "HTML",
    formatResolved: (resolution) => resolution.status === "answered"
      ? `<b>Answered in ${resolution.source}</b>: ${resolution.displayText}`
      : "<b>Cancelled</b>",
    parse: parser,
  });
  expect(await prompt.result).toEqual({ status: "answered", value: "accepted" });
  await service.drain();

  expect(requests.filter((request) => request.method === "sendMessage")).toHaveLength(1);
  expect(requests.find((request) => request.method === "editMessageText")?.body).toMatchObject({
    message_id: 311,
    text: "<b>Answered in telegram</b>: valid",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [] },
  });
  await service.shutdown();
});
