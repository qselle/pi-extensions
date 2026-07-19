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
    body: { offset: -1, timeout: 0, allowed_updates: ["message"] },
  });
  expect(requests[1].body).toMatchObject({
    text: "Question",
    message_thread_id: 42,
    reply_markup: { force_reply: true },
  });
  expect(requests[2]).toEqual({
    method: "getUpdates",
    body: { offset: 10, timeout: 20, allowed_updates: ["message"] },
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

test("mirrors a terminal winner back to Telegram and closes remote waiting", async () => {
  const sent: any[] = [];
  const service = new DefaultTelegramService(config, {
    emptyPollDelayMs: 0,
    fetch: (async (url, init) => {
      const method = methodOf(String(url));
      const body = JSON.parse(String(init?.body));
      if (method === "sendMessage") {
        sent.push(body);
        return response({ message_id: sent.length === 1 ? 80 : 81 });
      }
      if (body.offset === -1) return response([]);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as typeof fetch,
  });

  const prompt = await service.openPrompt({ text: "Question", parse: parser });
  await prompt.close({ status: "answered", source: "terminal", displayText: "Terminal answer" });
  expect(await prompt.result).toEqual({ status: "unavailable" });
  expect(sent.at(-1)).toMatchObject({
    text: expect.stringContaining("Terminal answer"),
    reply_parameters: { message_id: prompt.messageId },
  });
  await service.shutdown();
});
