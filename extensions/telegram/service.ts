import type { TelegramConfig } from "./config.ts";
import { TelegramApiClient, type TelegramApiOptions, type TelegramSendOptions, type TelegramSendResult } from "./api.ts";

const REGISTRY_KEY = Symbol.for("@qselle/pi-extensions.telegram-service.v1");
const DEFAULT_POLL_TIMEOUT_SECONDS = 20;

export type TelegramPromptParseResult<T> =
  | { status: "accepted"; value: T; displayText: string }
  | { status: "cancelled" }
  | { status: "rejected"; message?: string };

export interface TelegramPromptChoice<T> {
  label: string;
  value: T;
  displayText: string;
}

export type TelegramPromptResolution =
  | { status: "answered"; source: "terminal" | "telegram"; displayText: string }
  | { status: "cancelled"; source: "terminal" | "telegram" };

export interface TelegramPromptRequest<T> {
  text: string;
  inputPlaceholder?: string;
  choices?: readonly TelegramPromptChoice<T>[];
  parseMode?: "HTML";
  interactive?: boolean;
  formatResolved?(resolution: TelegramPromptResolution): string;
  parse(text: string): TelegramPromptParseResult<T>;
}

export type TelegramPromptResult<T> =
  | { status: "answered"; value: T }
  | { status: "cancelled" }
  | { status: "unavailable" };

export type TelegramPromptMirror =
  | { status: "answered"; source: "terminal"; displayText: string }
  | { status: "cancelled"; source: "terminal" };

export interface TelegramPromptHandle<T> {
  readonly messageId: number;
  readonly result: Promise<TelegramPromptResult<T>>;
  close(outcome: TelegramPromptMirror): Promise<void>;
}

export interface TelegramService {
  readonly questionDelayMs?: number;
  send(text: string, options?: TelegramSendOptions): Promise<TelegramSendResult>;
  openPrompt<T>(request: TelegramPromptRequest<T>, signal?: AbortSignal): Promise<TelegramPromptHandle<T>>;
  drain(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface TelegramServiceOptions extends TelegramApiOptions {
  pollTimeoutSeconds?: number;
  emptyPollDelayMs?: number;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id?: number;
  message_thread_id?: number;
  text?: string;
  chat?: { id?: number | string; username?: string };
  from?: { is_bot?: boolean };
  reply_to_message?: { message_id?: number };
}

interface TelegramCallbackQuery {
  id?: string;
  data?: string;
  from?: { is_bot?: boolean };
  message?: TelegramMessage;
}

interface PendingPrompt<T = unknown> {
  request: TelegramPromptRequest<T>;
  resolve(result: TelegramPromptResult<T>): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  abort?: () => void;
}

interface TelegramRegistry {
  owner?: symbol;
  service?: TelegramService;
}

const registry = ((globalThis as Record<PropertyKey, unknown>)[REGISTRY_KEY] ??= {}) as TelegramRegistry;

export function registerTelegramService(service: TelegramService): { unregister(): void } {
  const owner = Symbol("telegram-service-owner");
  registry.owner = owner;
  registry.service = service;
  return {
    unregister() {
      if (registry.owner !== owner) return;
      registry.owner = undefined;
      registry.service = undefined;
    },
  };
}

export function getTelegramService(): TelegramService | undefined {
  return registry.service;
}

export class DefaultTelegramService implements TelegramService {
  readonly questionDelayMs: number;
  private readonly api: TelegramApiClient;
  private readonly pollTimeoutSeconds: number;
  private readonly emptyPollDelayMs: number;
  private readonly pendingPrompts = new Map<number, PendingPrompt>();
  private readonly background = new Set<Promise<unknown>>();
  private offset = 0;
  private initialized = false;
  private initializing?: Promise<void>;
  private pollPromise?: Promise<void>;
  private pollController?: AbortController;
  private readonly lifecycleController = new AbortController();
  private stopped = false;

  constructor(
    private readonly config: TelegramConfig,
    options: TelegramServiceOptions = {},
  ) {
    this.api = new TelegramApiClient(config, options);
    this.questionDelayMs = (config.questionDelayMinutes ?? 0) * 60_000;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;
    this.emptyPollDelayMs = options.emptyPollDelayMs ?? 100;
  }

  send(text: string, options: TelegramSendOptions = {}): Promise<TelegramSendResult> {
    if (this.stopped) return Promise.reject(new Error("Telegram service is stopped"));
    return this.api.sendMessage(text, options);
  }

  async openPrompt<T>(
    request: TelegramPromptRequest<T>,
    signal?: AbortSignal,
  ): Promise<TelegramPromptHandle<T>> {
    if (this.stopped) throw new Error("Telegram service is stopped");
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const interactive = request.interactive !== false;
    if (interactive) await this.initializeOffset(signal);
    const choices = interactive ? request.choices ?? [] : [];
    const sent = await this.api.sendMessage(request.text, {
      signal,
      forceReply: interactive && choices.length === 0,
      inputPlaceholder: request.inputPlaceholder,
      inlineChoices: choices.map((choice, index) => ({
        text: choice.label,
        callbackData: `choice:${index}`,
      })),
      parseMode: request.parseMode,
    });
    if (sent.messageId === undefined) throw new Error("Telegram did not return a prompt message ID");
    const messageId = sent.messageId;

    let closed = false;
    const close = async (outcome: TelegramPromptMirror) => {
      if (closed) return;
      closed = true;
      this.removePrompt(messageId, { status: "unavailable" });
      const resolution: TelegramPromptResolution = outcome.status === "answered"
        ? { status: "answered", source: "terminal", displayText: outcome.displayText }
        : { status: "cancelled", source: "terminal" };
      const delivery = this.deliverResolution(messageId, request, resolution);
      this.track(delivery);
      await delivery;
    };

    if (!interactive) {
      return {
        messageId,
        result: Promise.resolve({ status: "unavailable" }),
        close,
      };
    }

    let resolveResult!: (result: TelegramPromptResult<T>) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<TelegramPromptResult<T>>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const pending: PendingPrompt<T> = {
      request,
      resolve: resolveResult,
      reject: rejectResult,
      signal,
    };
    if (signal) {
      pending.abort = () => {
        const removed = this.removePrompt(messageId, { status: "unavailable" });
        if (removed && hasInlineChoices(request)) this.track(this.api.clearInlineKeyboard(messageId));
      };
      signal.addEventListener("abort", pending.abort, { once: true });
    }
    this.pendingPrompts.set(messageId, pending as PendingPrompt);
    if (signal?.aborted) queueMicrotask(pending.abort!);
    this.ensurePoller();

    return { messageId, result, close };
  }

  async drain(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.lifecycleController.abort();
    this.pollController?.abort();
    for (const messageId of [...this.pendingPrompts.keys()]) {
      const pending = this.pendingPrompts.get(messageId);
      const removed = this.removePrompt(messageId, { status: "unavailable" });
      if (removed && pending && hasInlineChoices(pending.request)) {
        this.track(this.api.clearInlineKeyboard(messageId));
      }
    }
    await this.pollPromise?.catch(() => undefined);
    await this.drain();
  }

  private async initializeOffset(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    if (!this.initializing) {
      this.initializing = this.api.call("getUpdates", {
        offset: -1,
        timeout: 0,
        allowed_updates: ["message", "callback_query"],
      }, { signal: this.lifecycleController.signal }).then((updates) => {
        if (Array.isArray(updates)) this.advanceOffset(updates as TelegramUpdate[]);
        this.initialized = true;
      }).finally(() => {
        this.initializing = undefined;
      });
    }
    await withSignal(this.initializing, signal);
  }

  private ensurePoller(): void {
    if (this.pollPromise || this.pendingPrompts.size === 0 || this.stopped) return;
    this.pollPromise = this.poll().finally(() => {
      this.pollPromise = undefined;
      this.pollController = undefined;
      if (this.pendingPrompts.size > 0 && !this.stopped) this.ensurePoller();
    });
  }

  private async poll(): Promise<void> {
    while (this.pendingPrompts.size > 0 && !this.stopped) {
      const controller = new AbortController();
      this.pollController = controller;
      try {
        const updates = await this.api.call("getUpdates", {
          offset: this.offset,
          timeout: this.pollTimeoutSeconds,
          allowed_updates: ["message", "callback_query"],
        }, {
          signal: controller.signal,
          timeoutMs: (this.pollTimeoutSeconds * 1_000) + 5_000,
        });
        const list = Array.isArray(updates) ? updates as TelegramUpdate[] : [];
        this.advanceOffset(list);
        for (const update of list) await this.route(update);
        if (list.length === 0 && this.emptyPollDelayMs > 0) await sleep(this.emptyPollDelayMs);
      } catch (error) {
        if (controller.signal.aborted && (this.pendingPrompts.size === 0 || this.stopped)) return;
        for (const messageId of [...this.pendingPrompts.keys()]) this.rejectPrompt(messageId, error);
        return;
      }
    }
  }

  private advanceOffset(updates: TelegramUpdate[]): void {
    for (const update of updates) {
      if (Number.isInteger(update.update_id)) this.offset = Math.max(this.offset, (update.update_id as number) + 1);
    }
  }

  private async route(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) this.routeCallback(update.callback_query);
    if (update.message) await this.routeMessage(update.message);
  }

  private routeCallback(callback: TelegramCallbackQuery): void {
    const message = callback.message;
    const questionMessageId = message?.message_id;
    if (
      typeof callback.id !== "string"
      || questionMessageId === undefined
      || !this.matchesConfiguredCallback(callback)
    ) return;

    if (typeof callback.data !== "string" || !callback.data.startsWith("choice:")) return;
    const match = /^choice:(\d+)$/.exec(callback.data);
    const choiceIndex = match ? Number(match[1]) : -1;
    const pending = this.pendingPrompts.get(questionMessageId);
    const choice = Number.isInteger(choiceIndex) ? pending?.request.choices?.[choiceIndex] : undefined;
    if (!pending || !choice) {
      this.track(this.api.answerCallbackQuery(callback.id, "This option is no longer available."));
      return;
    }

    // Claim the race synchronously before any acknowledgement or cleanup I/O.
    if (!this.removePrompt(questionMessageId, { status: "answered", value: choice.value })) {
      this.track(this.api.answerCallbackQuery(callback.id, "This option is no longer available."));
      return;
    }
    this.track(this.api.answerCallbackQuery(callback.id, `Selected: ${choice.displayText}`));
    this.track(this.deliverResolution(questionMessageId, pending.request, {
      status: "answered",
      source: "telegram",
      displayText: choice.displayText,
    }));
  }

  private async routeMessage(message: TelegramMessage): Promise<void> {
    const questionMessageId = message.reply_to_message?.message_id;
    if (questionMessageId === undefined) return;
    const pending = this.pendingPrompts.get(questionMessageId);
    if (!pending || !this.matchesConfiguredTextReply(message)) return;
    const text = message.text?.trim();
    if (!text) return;

    const parsed = /^\/cancel(?:@\w+)?$/i.test(text)
      ? { status: "cancelled" as const }
      : pending.request.parse(text);
    if (parsed.status === "rejected") {
      const correction = parsed.message ?? "That reply is not valid for this question. Please try again or send /cancel.";
      await this.api.sendMessage(correction, { replyToMessageId: message.message_id }).catch(() => undefined);
      return;
    }
    if (parsed.status === "cancelled") {
      if (!this.removePrompt(questionMessageId, { status: "cancelled" })) return;
      this.track(this.deliverResolution(questionMessageId, pending.request, {
        status: "cancelled",
        source: "telegram",
      }));
      return;
    }

    if (!this.removePrompt(questionMessageId, { status: "answered", value: parsed.value })) return;
    this.track(this.deliverResolution(questionMessageId, pending.request, {
      status: "answered",
      source: "telegram",
      displayText: parsed.displayText,
    }));
  }

  private matchesConfiguredTextReply(message: TelegramMessage): boolean {
    return !message.from?.is_bot
      && typeof message.text === "string"
      && this.matchesConfiguredMessage(message);
  }

  private matchesConfiguredCallback(callback: TelegramCallbackQuery): boolean {
    return !callback.from?.is_bot
      && callback.message !== undefined
      && this.matchesConfiguredMessage(callback.message);
  }

  private matchesConfiguredMessage(message: TelegramMessage): boolean {
    if (!matchesChat(this.config.chatId, message.chat)) return false;
    if (this.config.threadId !== undefined && message.message_thread_id !== this.config.threadId) return false;
    return true;
  }

  private deliverResolution<T>(
    messageId: number,
    request: TelegramPromptRequest<T>,
    resolution: TelegramPromptResolution,
  ): Promise<void> {
    if (request.formatResolved) {
      const edited = Promise.resolve()
        .then(() => request.formatResolved!(resolution))
        .then((text) => this.api.editMessageText(messageId, text, { parseMode: request.parseMode }));
      if (!hasInlineChoices(request)) return edited;
      return edited.catch(async (error) => {
        await this.api.clearInlineKeyboard(messageId).catch(() => undefined);
        throw error;
      });
    }

    const text = resolution.status === "answered"
      ? resolution.source === "terminal"
        ? `✅ Pi · Reply received first in the terminal.\n\n${resolution.displayText}`
        : `✅ Pi · Reply received first on Telegram.\n\n${resolution.displayText}`
      : resolution.source === "terminal"
        ? "⏹ Pi · Question cancelled in the terminal."
        : "⏹ Pi · Question cancelled from Telegram.";
    const deliveries: Promise<unknown>[] = [
      this.api.sendMessage(text, { replyToMessageId: messageId }),
    ];
    if (hasInlineChoices(request)) deliveries.push(this.api.clearInlineKeyboard(messageId));
    return Promise.all(deliveries).then(() => undefined);
  }

  private removePrompt<T>(messageId: number, result: TelegramPromptResult<T>): boolean {
    const pending = this.pendingPrompts.get(messageId) as PendingPrompt<T> | undefined;
    if (!pending) return false;
    this.pendingPrompts.delete(messageId);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    pending.resolve(result);
    if (this.pendingPrompts.size === 0) this.pollController?.abort();
    return true;
  }

  private rejectPrompt(messageId: number, error: unknown): void {
    const pending = this.pendingPrompts.get(messageId);
    if (!pending) return;
    this.pendingPrompts.delete(messageId);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    pending.reject(error);
    if (hasInlineChoices(pending.request)) this.track(this.api.clearInlineKeyboard(messageId));
    if (this.pendingPrompts.size === 0) this.pollController?.abort();
  }

  private track<T>(promise: Promise<T>): void {
    let tracked: Promise<unknown>;
    tracked = promise.catch(() => undefined).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }
}

function hasInlineChoices(request: TelegramPromptRequest<unknown>): boolean {
  return (request.choices?.length ?? 0) > 0;
}

function matchesChat(configured: string, chat: TelegramMessage["chat"]): boolean {
  if (!chat) return false;
  if (/^-?\d+$/.test(configured)) return String(chat.id) === configured;
  const username = chat.username ? `@${chat.username}` : "";
  return username.toLowerCase() === configured.toLowerCase();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  let rejectAbort!: (error: DOMException) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
