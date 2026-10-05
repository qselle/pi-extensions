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
  answerUserId: "777",
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
        { update_id: 10, message: { message_id: 70, from: { id: 777 }, text: "valid", chat: { id: -999 }, reply_to_message: { message_id: 50 } } },
        { update_id: 11, message: { message_id: 71, from: { id: 777 }, text: "invalid", chat: { id: -1001234567890 }, message_thread_id: 42, reply_to_message: { message_id: 50 } } },
        { update_id: 12, message: { message_id: 72, from: { id: 777 }, text: "valid", chat: { id: -1001234567890 }, message_thread_id: 42, reply_to_message: { message_id: 50 } } },
      ]);
    }),
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
    }),
  });

  const first = await service.openPrompt({ text: "First", parse: parser });
  const second = await service.openPrompt({ text: "Second", parse: parser });
  resolvePoll(response([
    { update_id: 1, message: { message_id: 201, from: { id: 777 }, text: "valid", chat: { id: -1001234567890 }, message_thread_id: 42, reply_to_message: { message_id: first.messageId } } },
    { update_id: 2, message: { message_id: 202, from: { id: 777 }, text: "valid", chat: { id: -1001234567890 }, message_thread_id: 42, reply_to_message: { message_id: second.messageId } } },
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
            from: { id: 777 },
            id: "wrong-chat",
            data: "choice:0",
            message: { message_id: 50, message_thread_id: 42, chat: { id: -999 } },
          },
        },
        {
          update_id: 11,
          callback_query: {
            from: { id: 777 },
            id: "wrong-topic",
            data: "choice:0",
            message: { message_id: 50, message_thread_id: 7, chat: { id: -1001234567890 } },
          },
        },
        {
          update_id: 12,
          callback_query: {
            from: { id: 777 },
            id: "invalid-choice",
            data: "choice:9",
            message: { message_id: 50, message_thread_id: 42, chat: { id: -1001234567890 } },
          },
        },
        {
          update_id: 13,
          callback_query: {
            from: { id: 777 },
            id: "valid-choice",
            data: "choice:1",
            message: { message_id: 50, message_thread_id: 42, chat: { id: -1001234567890 } },
          },
        },
        {
          update_id: 14,
          callback_query: {
            from: { id: 777 },
            id: "stale-choice",
            data: "choice:0",
            message: { message_id: 50, message_thread_id: 42, chat: { id: -1001234567890 } },
          },
        },
      ]);
    }),
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
          from: { id: 777 },
          text: "custom destination",
          chat: { id: -1001234567890 },
          message_thread_id: 42,
          reply_to_message: { message_id: 85 },
        },
      }]);
    }),
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
          from: { id: 777 },
          text: "/cancel",
          chat: { id: -1001234567890 },
          message_thread_id: 42,
          reply_to_message: { message_id: 90 },
        },
      }]);
    }),
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
    }),
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
    }),
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
    }),
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
          from: { id: 777 },
          text: "valid",
          chat: { id: -1001234567890 },
          message_thread_id: 42,
          reply_to_message: { message_id: 311 },
        },
      }]);
    }),
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

test("marks interactive and passive cards closed during shutdown", async () => {
  const requests: Array<{ method: string; body: any }> = [];
  let sendId = 400;
  const service = new DefaultTelegramService(config, {
    emptyPollDelayMs: 0,
    fetch: (async (url, init) => {
      const method = methodOf(String(url));
      const body = JSON.parse(String(init?.body));
      requests.push({ method, body });
      if (method === "sendMessage") return response({ message_id: ++sendId });
      if (method === "editMessageText") return response(true);
      if (body.offset === -1) return response([]);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }),
  });
  const render = (resolution: { status: string }) => resolution.status === "closed"
    ? "<b>Question closed</b>"
    : "<b>Resolved</b>";

  const interactive = await service.openPrompt({
    text: "<b>Input needed</b>",
    parseMode: "HTML",
    choices: [{ label: "A", value: "A", displayText: "A" }],
    formatResolved: render,
    parse: parser,
  });
  const passive = await service.openPrompt({
    text: "<b>Secret input needed</b>",
    parseMode: "HTML",
    interactive: false,
    formatResolved: render,
    parse: parser,
  });

  await service.shutdown();
  expect(await interactive.result).toEqual({ status: "unavailable" });
  expect(await passive.result).toEqual({ status: "unavailable" });
  expect(requests
    .filter((request) => request.method === "editMessageText")
    .map((request) => [request.body.message_id, request.body.text]))
    .toEqual([
      [interactive.messageId, "<b>Question closed</b>"],
      [passive.messageId, "<b>Question closed</b>"],
    ]);

  await passive.close({ status: "cancelled", source: "terminal" });
  expect(requests.filter((request) => request.method === "editMessageText")).toHaveLength(2);
});

test("marks a card closed when Telegram polling fails", async () => {
  const requests: Array<{ method: string; body: any }> = [];
  let updatesCalls = 0;
  const service = new DefaultTelegramService(config, {
    emptyPollDelayMs: 0,
    fetch: (async (url, init) => {
      const method = methodOf(String(url));
      const body = JSON.parse(String(init?.body));
      requests.push({ method, body });
      if (method === "sendMessage") return response({ message_id: 501 });
      if (method === "editMessageText") return response(true);
      updatesCalls++;
      if (updatesCalls === 1) return response([]);
      return new Response(JSON.stringify({ ok: false }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }),
  });

  const prompt = await service.openPrompt({
    text: "<b>Input needed</b>",
    parseMode: "HTML",
    choices: [{ label: "A", value: "A", displayText: "A" }],
    formatResolved: (resolution) => resolution.status === "closed"
      ? "<b>Question closed</b>"
      : "<b>Resolved</b>",
    parse: parser,
  });
  await expect(prompt.result).rejects.toThrow();
  await service.drain();

  expect(requests.find((request) => request.method === "editMessageText")?.body).toMatchObject({
    message_id: 501,
    text: "<b>Question closed</b>",
    reply_markup: { inline_keyboard: [] },
  });

  await prompt.close({ status: "answered", source: "terminal", displayText: "A" });
  await service.drain();
  expect(requests
    .filter((request) => request.method === "editMessageText")
    .map((request) => request.body.text))
    .toEqual(["<b>Question closed</b>", "<b>Resolved</b>"]);
  await service.shutdown();
});

test("question replies and corrections stay pinned to their original session topics", async () => {
  const requests: Array<{ method: string; body: any }> = [];
  let thread = 101;
  let messageId = 0;
  let release!: (updates: any[]) => void;
  const incoming = new Promise<any[]>((resolve) => { release = resolve; });
  const service = new DefaultTelegramService({ ...config, threadId: undefined }, {
    topics: { resolve: async () => ({ threadId: thread }) } as any,
    inbox: { initialize: async () => {}, read: async () => incoming },
    emptyPollDelayMs: 0,
    fetch: async (url, init) => {
      const method = methodOf(String(url));
      const body = JSON.parse(String(init?.body));
      requests.push({ method, body });
      return response(method === "sendMessage" ? { message_id: ++messageId } : true);
    },
  });
  const first = await service.openPrompt({ text: "First question", parse: parser });
  thread = 202;
  const second = await service.openPrompt({ text: "Second question", parse: parser });
  const answer = (id: number, prompt: number, topic: number, text: string) => ({ update_id: id, message: {
    message_id: 100 + id, from: { id: 777 }, text, chat: { id: config.chatId }, message_thread_id: topic, reply_to_message: { message_id: prompt },
  } });
  release([answer(1, first.messageId, 202, "valid"), answer(2, first.messageId, 101, "invalid"),
    answer(3, second.messageId, 202, "valid"), answer(4, first.messageId, 101, "valid")]);
  expect(await first.result).toEqual({ status: "answered", value: "accepted" });
  expect(await second.result).toEqual({ status: "answered", value: "accepted" });
  await service.drain();
  expect(requests.find((request) => request.body.text === "Try again")?.body.message_thread_id).toBe(101);
  const receipts = requests.filter((request) => String(request.body.text).includes("Reply received first"));
  expect(receipts.map((request) => [request.body.reply_parameters.message_id, request.body.message_thread_id])).toEqual([[second.messageId, 202], [first.messageId, 101]]);
  await service.shutdown();
});

test("accepts answers only from the configured user in a group", async () => {
  const requests: Array<{ method: string; body: any }> = [];
  let release!: (updates: any[]) => void;
  let reads = 0;
  const batches = [new Promise<any[]>((resolve) => { release = resolve; })];
  const service = new DefaultTelegramService(config, {
    inbox: { initialize: async () => {}, read: async (signal) => (reads++ === 0 ? batches[0]! : new Promise<any[]>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))) },
    emptyPollDelayMs: 0,
    fetch: async (url, init) => {
      const method = methodOf(String(url));
      requests.push({ method, body: JSON.parse(String(init?.body)) });
      return response(method === "sendMessage" ? { message_id: 600 } : true);
    },
  });
  const prompt = await service.openPrompt<string>({
    text: "Deploy?",
    choices: [{ label: "Yes", value: "yes", displayText: "Yes" }],
    parse: (text) => ({ status: "accepted", value: text, displayText: text }),
  });
  const message = { message_id: 600, message_thread_id: 42, chat: { id: -1001234567890 } };
  release([
    { update_id: 1, message: { ...message, message_id: 601, from: { id: 888 }, text: "member reply", reply_to_message: { message_id: 600 } } },
    { update_id: 2, message: { ...message, message_id: 602, text: "anonymous reply", reply_to_message: { message_id: 600 } } },
    { update_id: 3, callback_query: { id: "member-button", data: "choice:0", from: { id: 888 }, message } },
    { update_id: 4, message: { ...message, message_id: 603, from: { id: 777 }, text: "owner reply", reply_to_message: { message_id: 600 } } },
  ]);
  expect(await prompt.result).toEqual({ status: "answered", value: "owner reply" });
  await service.drain();
  expect(requests.filter((request) => request.method === "answerCallbackQuery").map((request) => request.body)).toEqual([
    { callback_query_id: "member-button", text: "Only the configured Telegram user can answer this question." },
  ]);
  expect(requests.some((request) => String(request.body.text).includes("member reply"))).toBe(false);
  await service.shutdown();
});

test("private chats accept their own user and groups without answerUserId accept nobody", async () => {
  const run = async (chatId: string, fromId: number) => {
    let delivered = false;
    const service = new DefaultTelegramService({ ...config, chatId, answerUserId: undefined, threadId: undefined }, {
      inbox: { initialize: async () => {}, read: async (signal) => {
        if (delivered) return new Promise<any[]>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        delivered = true;
        return [{ update_id: 1, message: { message_id: 701, from: { id: fromId }, text: "valid", chat: { id: Number(chatId) }, reply_to_message: { message_id: 700 } } }];
      } },
      emptyPollDelayMs: 0,
      fetch: async (url) => response(methodOf(String(url)) === "sendMessage" ? { message_id: 700 } : true),
    });
    const controller = new AbortController();
    const prompt = await service.openPrompt({ text: "Question", parse: parser }, controller.signal);
    const outcome = await Promise.race([prompt.result, new Promise((resolve) => setTimeout(() => resolve("pending"), 50))]);
    controller.abort();
    await service.shutdown();
    return outcome;
  };
  expect(await run("12345", 12345)).toEqual({ status: "answered", value: "accepted" });
  expect(await run("12345", 54321)).toBe("pending");
  expect(await run("-100555", 12345)).toBe("pending");
});
