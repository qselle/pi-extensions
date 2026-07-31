import { expect, test } from "bun:test";
import { TelegramApiClient, TelegramApiError } from "./api.ts";
import type { TelegramConfig } from "./config.ts";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi";
const config: TelegramConfig = {
  botToken: TOKEN,
  chatId: "-1001234567890",
  threadId: 42,
  details: "summary",
  questionDelayMinutes: 5,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function captureApiError(promise: Promise<unknown>): Promise<TelegramApiError> {
  try {
    await promise;
    throw new Error("Expected Telegram API call to fail");
  } catch (error) {
    if (!(error instanceof TelegramApiError)) throw error;
    return error;
  }
}

test("posts messages through the shared API client", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const api = new TelegramApiClient(config, {
    fetch: (async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ ok: true, result: { message_id: 17 } });
    }),
  });

  expect(await api.sendMessage("Goal complete", {
    forceReply: true,
    inputPlaceholder: "Reply here",
    replyToMessageId: 9,
  })).toEqual({ messageId: 17 });
  expect(requests[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  expect(JSON.parse(String(requests[0].init?.body))).toEqual({
    chat_id: "-1001234567890",
    text: "Goal complete",
    disable_web_page_preview: true,
    message_thread_id: 42,
    reply_markup: { force_reply: true, input_field_placeholder: "Reply here" },
    reply_parameters: { message_id: 9 },
  });
});

test("renders inline choices and exposes callback/control helpers", async () => {
  const requests: Array<{ method: string; body: any }> = [];
  const api = new TelegramApiClient(config, {
    fetch: (async (url, init) => {
      const method = String(url).slice(String(url).lastIndexOf("/") + 1);
      const body = JSON.parse(String(init?.body));
      requests.push({ method, body });
      return jsonResponse({ ok: true, result: method === "sendMessage" ? { message_id: 21 } : true });
    }),
  });

  const longLabel = "x".repeat(80);
  await api.sendMessage("Choose", {
    forceReply: true,
    inlineChoices: [
      { text: "  Staging  ", callbackData: "choice:0" },
      { text: longLabel, callbackData: "choice:1" },
    ],
  });
  await api.answerCallbackQuery("callback-1", "Selected: Staging");
  await api.clearInlineKeyboard(21);
  await api.editMessageText(21, "<b>Answered</b>", { parseMode: "HTML" });

  expect(requests[0]).toEqual({
    method: "sendMessage",
    body: {
      chat_id: "-1001234567890",
      text: "Choose",
      disable_web_page_preview: true,
      message_thread_id: 42,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Staging", callback_data: "choice:0" }],
          [{ text: `${"x".repeat(63)}…`, callback_data: "choice:1" }],
        ],
      },
    },
  });
  expect(requests[1]).toEqual({
    method: "answerCallbackQuery",
    body: { callback_query_id: "callback-1", text: "Selected: Staging" },
  });
  expect(requests[2]).toEqual({
    method: "editMessageReplyMarkup",
    body: {
      chat_id: "-1001234567890",
      message_id: 21,
      reply_markup: { inline_keyboard: [] },
    },
  });
  expect(requests[3]).toEqual({
    method: "editMessageText",
    body: {
      chat_id: "-1001234567890",
      message_id: 21,
      text: "<b>Answered</b>",
      disable_web_page_preview: true,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    },
  });
});

test("retries only bounded explicit sendMessage rate limits", async () => {
  let calls = 0;
  const delays: number[] = [];
  const api = new TelegramApiClient(config, {
    fetch: (async () => {
      calls++;
      return calls === 1
        ? jsonResponse({ ok: false, parameters: { retry_after: 2 } }, 429)
        : jsonResponse({ ok: true, result: { message_id: 18 } });
    }),
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });
  expect((await api.sendMessage("test")).messageId).toBe(18);
  expect(delays).toEqual([2_000]);

  const limited = new TelegramApiClient(config, {
    fetch: (async () => jsonResponse({ ok: false, parameters: { retry_after: 30 } }, 429)),
  });
  await expect(limited.sendMessage("test")).rejects.toMatchObject({ code: "rate_limited", status: 429 });
});

test("sanitizes server and network failures", async () => {
  const rejected = new TelegramApiClient(config, {
    fetch: (async () => jsonResponse({ ok: false, description: `leaked ${TOKEN}` }, 500)),
  });
  const serverError = await captureApiError(rejected.sendMessage("test"));
  expect(serverError).toMatchObject({ code: "rejected", status: 500 });
  expect(serverError.message).not.toContain(TOKEN);

  const offline = new TelegramApiClient(config, {
    fetch: (async () => { throw new Error(`URL includes ${TOKEN}`); }),
  });
  const networkError = await captureApiError(offline.sendMessage("test"));
  expect(networkError.code).toBe("network");
  expect(networkError.message).not.toContain(TOKEN);
});

test("times out stalled requests, including response bodies", async () => {
  const stalled = new TelegramApiClient(config, {
    timeoutMs: 5,
    fetch: ((_: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })),
  });
  await expect(stalled.sendMessage("test")).rejects.toMatchObject({ code: "timeout" });

  const stalledBody = new TelegramApiClient(config, {
    timeoutMs: 5,
    fetch: (async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    }), { status: 200 })),
  });
  await expect(stalledBody.sendMessage("test")).rejects.toMatchObject({ code: "timeout" });
});

test("rejects invalid and oversized Telegram responses", async () => {
  const invalid = new TelegramApiClient(config, {
    fetch: (async () => new Response("not json", { status: 200 })),
  });
  await expect(invalid.sendMessage("test")).rejects.toMatchObject({ code: "response" });

  const oversized = new TelegramApiClient(config, {
    fetch: (async () => new Response("x".repeat(70_000), { status: 200 })),
  });
  await expect(oversized.sendMessage("test")).rejects.toMatchObject({ code: "response" });
});
