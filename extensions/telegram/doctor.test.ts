import { expect, test } from "bun:test";
import { diagnoseTelegram, formatTelegramDiagnostics } from "./doctor.ts";
import type { TelegramConfig } from "./config.ts";

const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi";
const config: TelegramConfig = { botToken: token, chatId: "123456789", details: "summary", questionDelayMinutes: 5 };
function harness(results: Record<string, unknown>) {
  const calls: string[] = [];
  const fetch = async (url: Parameters<typeof globalThis.fetch>[0]) => {
    const method = String(url).split("/").at(-1)!;
    calls.push(method);
    if (!(method in results)) throw new Error(`Unexpected method ${method}`);
    const result = results[method];
    return result instanceof Response ? result : Response.json({ ok: true, result });
  };
  return { calls, fetch };
}

test("doctor checks bot, recipient, webhook and private topics without messages or updates", async () => {
  const h = harness({ getMe: { id: 123456789, is_bot: true, has_topics_enabled: true }, getChat: { id: 123456789, type: "private" }, getWebhookInfo: { url: "" } });
  const checks = await diagnoseTelegram(config, h);
  expect(h.calls.sort()).toEqual(["getChat", "getMe", "getWebhookInfo"]);
  expect(checks).toHaveLength(4);
  expect(checks.every((check) => check.status === "ok")).toBe(true);
  expect(formatTelegramDiagnostics(checks)).toContain("read-only");
});

test("doctor identifies webhook conflicts without exposing the webhook URL or error detail", async () => {
  const secretUrl = "https://example.com/private-webhook-token";
  const h = harness({ getMe: { id: 123456789, is_bot: true }, getChat: { type: "private" }, getWebhookInfo: { url: secretUrl, last_error_message: token } });
  const checks = await diagnoseTelegram(config, h);
  expect(checks.find((check) => check.name === "Replies")).toMatchObject({ status: "error", message: expect.stringContaining("active webhook") });
  expect(checks.find((check) => check.name === "Topics")).toMatchObject({ status: "warning", message: expect.stringContaining("General") });
  expect(JSON.stringify(checks)).not.toContain(secretUrl);
  expect(JSON.stringify(checks)).not.toContain(token);
});

test("doctor independently reports errors and rejects malformed successful responses", async () => {
  const h = harness({ getMe: new Response(JSON.stringify({ ok: false, description: token }), { status: 401 }), getChat: null, getWebhookInfo: {} });
  const checks = await diagnoseTelegram(config, h);
  expect(checks).toHaveLength(3);
  expect(checks.every((check) => check.status === "error")).toBe(true);
  expect(JSON.stringify(checks)).not.toContain(token);
  expect(h.calls).toHaveLength(3);
});

test("doctor verifies forum topic permission and distinguishes required or fixed topics", async () => {
  const h = harness({ getMe: { id: 123456789, is_bot: true }, getChat: { type: "supergroup", is_forum: true }, getWebhookInfo: { url: "" }, getChatMember: { status: "administrator", can_manage_topics: false } });
  expect((await diagnoseTelegram({ ...config, chatId: "-100123456789" }, h)).find((check) => check.name === "Topics")).toMatchObject({ status: "error", message: expect.stringContaining("administrator permission") });
  expect(h.calls).toContain("getChatMember");
  const unavailable = harness({ getMe: { id: 123456789, is_bot: true }, getChat: { type: "private" }, getWebhookInfo: { url: "" } });
  expect((await diagnoseTelegram({ ...config, topics: "required" }, unavailable)).find((check) => check.name === "Topics")?.status).toBe("error");
  expect((await diagnoseTelegram({ ...config, threadId: 7 }, unavailable)).find((check) => check.name === "Topics")).toMatchObject({ status: "warning", message: expect.stringContaining("fixed topic") });
});
