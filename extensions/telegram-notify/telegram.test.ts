import { expect, test } from "bun:test";
import { sendTelegramMessage, TelegramDeliveryError } from "./telegram.ts";
import type { TelegramConfig } from "./config.ts";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi";
const config: TelegramConfig = {
  botToken: TOKEN,
  chatId: "-1001234567890",
  threadId: 42,
  details: "summary",
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("posts a plain-text Telegram message to the configured chat and topic", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const result = await sendTelegramMessage(config, "Goal complete", {
    fetch: (async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ ok: true, result: { message_id: 17 } });
    }) as typeof fetch,
  });

  expect(result).toEqual({ messageId: 17 });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  expect(requests[0].init?.method).toBe("POST");
  expect(JSON.parse(String(requests[0].init?.body))).toEqual({
    chat_id: "-1001234567890",
    text: "Goal complete",
    disable_web_page_preview: true,
    message_thread_id: 42,
  });
});

test("retries only a bounded explicit 429 retry_after", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await sendTelegramMessage(config, "Goal complete", {
    fetch: (async () => {
      calls++;
      return calls === 1
        ? jsonResponse({ ok: false, parameters: { retry_after: 2 } }, 429)
        : jsonResponse({ ok: true, result: { message_id: 18 } });
    }) as typeof fetch,
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });
  expect(result.messageId).toBe(18);
  expect(calls).toBe(2);
  expect(delays).toEqual([2_000]);

  calls = 0;
  await expect(sendTelegramMessage(config, "Goal complete", {
    fetch: (async () => {
      calls++;
      return jsonResponse({ ok: false, parameters: { retry_after: 30 } }, 429);
    }) as typeof fetch,
  })).rejects.toMatchObject({ code: "rate_limited", status: 429 });
  expect(calls).toBe(1);
});

test("does not retry ambiguous server or network failures and redacts the token", async () => {
  let calls = 0;
  const serverError = await sendTelegramMessage(config, "Goal complete", {
    fetch: (async () => {
      calls++;
      return jsonResponse({ ok: false, description: `leaked ${TOKEN}` }, 500);
    }) as typeof fetch,
  }).catch((error) => error as TelegramDeliveryError);
  expect(calls).toBe(1);
  expect(serverError.code).toBe("rejected");
  expect(serverError.message).not.toContain(TOKEN);

  calls = 0;
  const networkError = await sendTelegramMessage(config, "Goal complete", {
    fetch: (async () => {
      calls++;
      throw new Error(`request URL contains ${TOKEN}`);
    }) as typeof fetch,
  }).catch((error) => error as TelegramDeliveryError);
  expect(calls).toBe(1);
  expect(networkError.code).toBe("network");
  expect(networkError.message).not.toContain(TOKEN);
});

test("aborts a stalled Telegram request after the timeout", async () => {
  const error = await sendTelegramMessage(config, "Goal complete", {
    timeoutMs: 5,
    fetch: ((_: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch,
  }).catch((value) => value as TelegramDeliveryError);
  expect(error).toMatchObject({ code: "timeout", message: "Telegram notification timed out." });
  expect(error.message).not.toContain(TOKEN);
});

test("keeps the timeout active while reading the response body", async () => {
  const error = await sendTelegramMessage(config, "Goal complete", {
    timeoutMs: 5,
    fetch: (async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch,
  }).catch((value) => value as TelegramDeliveryError);
  expect(error).toMatchObject({ code: "timeout", message: "Telegram notification timed out." });
});

test("rejects invalid and oversized Telegram responses safely", async () => {
  await expect(sendTelegramMessage(config, "Goal complete", {
    fetch: (async () => new Response("not json", { status: 200 })) as typeof fetch,
  })).rejects.toMatchObject({ code: "response" });

  await expect(sendTelegramMessage(config, "Goal complete", {
    fetch: (async () => new Response("x".repeat(70_000), { status: 200 })) as typeof fetch,
  })).rejects.toMatchObject({ code: "response" });
});
