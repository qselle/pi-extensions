import type { TelegramConfig } from "./config.ts";

const TELEGRAM_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RETRY_AFTER_SECONDS = 5;

export interface TelegramSendResult {
  messageId?: number;
}

export interface TelegramTransportOptions {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

export class TelegramDeliveryError extends Error {
  constructor(
    message: string,
    readonly code: "timeout" | "network" | "response" | "rejected" | "rate_limited",
    readonly status?: number,
  ) {
    super(message);
    this.name = "TelegramDeliveryError";
  }
}

export async function sendTelegramMessage(
  config: TelegramConfig,
  text: string,
  options: TelegramTransportOptions = {},
): Promise<TelegramSendResult> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? TELEGRAM_TIMEOUT_MS;
  const body: Record<string, unknown> = {
    chat_id: config.chatId,
    text,
    disable_web_page_preview: true,
  };
  if (config.threadId !== undefined) body.message_thread_id = config.threadId;

  for (let attempt = 0; attempt < 2; attempt++) {
    const { response, payload } = await telegramAttempt(config.botToken, body, fetchImpl, timeoutMs);
    if (response.status === 429 && attempt === 0) {
      const retryAfter = payload?.parameters?.retry_after;
      if (Number.isInteger(retryAfter) && retryAfter >= 0 && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
        await sleep(retryAfter * 1_000);
        continue;
      }
    }
    if (response.status === 429) {
      throw new TelegramDeliveryError("Telegram rate-limited the notification.", "rate_limited", response.status);
    }
    if (!response.ok || payload?.ok !== true) {
      throw new TelegramDeliveryError(
        `Telegram rejected the notification${response.status ? ` (HTTP ${response.status})` : ""}.`,
        "rejected",
        response.status,
      );
    }
    const messageId = payload.result?.message_id;
    return { messageId: typeof messageId === "number" ? messageId : undefined };
  }
  throw new TelegramDeliveryError("Telegram rate-limited the notification.", "rate_limited", 429);
}

async function telegramAttempt(
  botToken: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ response: Response; payload: any }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      if (timedOut) throw new TelegramDeliveryError("Telegram notification timed out.", "timeout");
      throw new TelegramDeliveryError("Telegram notification could not reach the service.", "network");
    }
    try {
      return { response, payload: await parseTelegramResponse(response) };
    } catch (error) {
      if (timedOut) throw new TelegramDeliveryError("Telegram notification timed out.", "timeout");
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

async function parseTelegramResponse(response: Response): Promise<any> {
  const body = response.body;
  if (!body) return undefined;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new TelegramDeliveryError("Telegram returned an oversized response.", "response", response.status);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof TelegramDeliveryError) throw error;
    throw new TelegramDeliveryError("Telegram returned an unreadable response.", "response", response.status);
  }
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new TelegramDeliveryError("Telegram returned an invalid response.", "response", response.status);
  }
}
