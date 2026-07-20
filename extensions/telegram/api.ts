import type { TelegramConfig } from "./config.ts";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RETRY_AFTER_SECONDS = 5;
const MAX_INLINE_BUTTON_CHARS = 64;
const MAX_CALLBACK_NOTICE_CHARS = 200;

export interface TelegramApiOptions {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

export interface TelegramRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TelegramInlineChoice {
  text: string;
  callbackData: string;
}

export interface TelegramSendOptions extends TelegramRequestOptions {
  forceReply?: boolean;
  inputPlaceholder?: string;
  replyToMessageId?: number;
  inlineChoices?: readonly TelegramInlineChoice[];
  parseMode?: "HTML";
}

export interface TelegramSendResult {
  messageId?: number;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly code: "timeout" | "network" | "response" | "rejected" | "rate_limited",
    readonly status?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export class TelegramApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly defaultTimeoutMs: number;

  constructor(
    readonly config: TelegramConfig,
    options: TelegramApiOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async sendMessage(text: string, options: TelegramSendOptions = {}): Promise<TelegramSendResult> {
    const body: Record<string, unknown> = {
      chat_id: this.config.chatId,
      text,
      disable_web_page_preview: true,
    };
    if (this.config.threadId !== undefined) body.message_thread_id = this.config.threadId;
    if (options.parseMode) body.parse_mode = options.parseMode;
    if (options.inlineChoices && options.inlineChoices.length > 0) {
      body.reply_markup = {
        inline_keyboard: options.inlineChoices.map((choice) => [{
          text: clipCharacters(choice.text.replace(/\s+/gu, " ").trim(), MAX_INLINE_BUTTON_CHARS),
          callback_data: choice.callbackData,
        }]),
      };
    } else if (options.forceReply) {
      body.reply_markup = {
        force_reply: true,
        ...(options.inputPlaceholder ? { input_field_placeholder: options.inputPlaceholder } : {}),
      };
    }
    if (options.replyToMessageId !== undefined) {
      body.reply_parameters = { message_id: options.replyToMessageId };
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.call("sendMessage", body, options);
        const messageId = result?.message_id;
        return { messageId: typeof messageId === "number" ? messageId : undefined };
      } catch (error) {
        if (!(error instanceof TelegramApiError) || error.code !== "rate_limited" || attempt > 0) throw error;
        const retryAfter = (error as TelegramApiError & { retryAfter?: number }).retryAfter;
        if (!Number.isInteger(retryAfter) || retryAfter! < 0 || retryAfter! > MAX_RETRY_AFTER_SECONDS) throw error;
        await abortableSleep(retryAfter! * 1_000, options.signal, this.sleep);
      }
    }
    throw new TelegramApiError("Telegram rate-limited the request.", "rate_limited", 429);
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text: string,
    options: TelegramRequestOptions = {},
  ): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: clipCharacters(text, MAX_CALLBACK_NOTICE_CHARS),
    }, options);
  }

  async clearInlineKeyboard(messageId: number, options: TelegramRequestOptions = {}): Promise<void> {
    await this.call("editMessageReplyMarkup", {
      chat_id: this.config.chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    }, options);
  }

  async editMessageText(
    messageId: number,
    text: string,
    options: TelegramRequestOptions & { parseMode?: "HTML" } = {},
  ): Promise<void> {
    await this.call("editMessageText", {
      chat_id: this.config.chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
      reply_markup: { inline_keyboard: [] },
    }, options);
  }

  async call(method: string, body: Record<string, unknown>, options: TelegramRequestOptions = {}): Promise<any> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? this.defaultTimeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.botToken}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (timedOut) throw new TelegramApiError("Telegram request timed out.", "timeout");
        throw new TelegramApiError("Telegram request could not reach the service.", "network");
      }

      const payload = await parseResponse(response, options.signal, () => timedOut);
      if (response.status === 429) {
        const error = new TelegramApiError("Telegram rate-limited the request.", "rate_limited", 429) as TelegramApiError & { retryAfter?: number };
        const retryAfter = payload?.parameters?.retry_after;
        if (Number.isInteger(retryAfter)) error.retryAfter = retryAfter;
        throw error;
      }
      if (!response.ok || payload?.ok !== true) {
        throw new TelegramApiError(
          `Telegram rejected the request${response.status ? ` (HTTP ${response.status})` : ""}.`,
          "rejected",
          response.status,
        );
      }
      return payload.result;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}

function clipCharacters(value: string, limit: number): string {
  const characters = [...value];
  return characters.length <= limit ? value : `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

export function safeTelegramError(error: unknown): string {
  return error instanceof TelegramApiError
    ? error.message
    : "Telegram request failed unexpectedly.";
}

async function abortableSleep(
  milliseconds: number,
  signal: AbortSignal | undefined,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  if (!signal) return sleep(milliseconds);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  let rejectAbort!: (error: DOMException) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([sleep(milliseconds), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function parseResponse(
  response: Response,
  signal: AbortSignal | undefined,
  timedOut: () => boolean,
): Promise<any> {
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
        throw new TelegramApiError("Telegram returned an oversized response.", "response", response.status);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (timedOut()) throw new TelegramApiError("Telegram request timed out.", "timeout");
    if (error instanceof TelegramApiError) throw error;
    throw new TelegramApiError("Telegram returned an unreadable response.", "response", response.status);
  }
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new TelegramApiError("Telegram returned an invalid response.", "response", response.status);
  }
}
