import type { TelegramConfig } from "./config.ts";
import { TelegramApiClient, type TelegramApiOptions, type TelegramSendOptions, type TelegramSendResult } from "./api.ts";

const REGISTRY_KEY = Symbol.for("@qselle/pi-extensions.telegram-service.v1");
const DEFAULT_POLL_TIMEOUT_SECONDS = 20;

export type TelegramPromptParseResult<T> =
  | { status: "accepted"; value: T; displayText: string }
  | { status: "cancelled" }
  | { status: "rejected"; message?: string };

export interface TelegramPromptRequest<T> {
  text: string;
  inputPlaceholder?: string;
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
}

interface TelegramMessage {
  message_id?: number;
  message_thread_id?: number;
  text?: string;
  chat?: { id?: number | string; username?: string };
  from?: { is_bot?: boolean };
  reply_to_message?: { message_id?: number };
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
    await this.initializeOffset(signal);
    const sent = await this.api.sendMessage(request.text, {
      signal,
      forceReply: true,
      inputPlaceholder: request.inputPlaceholder,
    });
    if (sent.messageId === undefined) throw new Error("Telegram did not return a prompt message ID");
    const messageId = sent.messageId;

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
      pending.abort = () => this.removePrompt(messageId, { status: "unavailable" });
      signal.addEventListener("abort", pending.abort, { once: true });
    }
    this.pendingPrompts.set(messageId, pending as PendingPrompt);
    if (signal?.aborted) queueMicrotask(pending.abort!);
    this.ensurePoller();

    let closed = false;
    return {
      messageId,
      result,
      close: async (outcome) => {
        if (closed) return;
        closed = true;
        this.removePrompt(messageId, { status: "unavailable" });
        const text = outcome.status === "answered"
          ? `✅ Pi · Reply received first in the terminal.\n\n${outcome.displayText}`
          : "⏹ Pi · Question cancelled in the terminal.";
        const delivery = this.api.sendMessage(text, { replyToMessageId: messageId });
        this.track(delivery);
        await delivery;
      },
    };
  }

  async drain(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.lifecycleController.abort();
    this.pollController?.abort();
    for (const messageId of [...this.pendingPrompts.keys()]) {
      this.removePrompt(messageId, { status: "unavailable" });
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
        allowed_updates: ["message"],
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
          allowed_updates: ["message"],
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
    const message = update.message;
    const questionMessageId = message?.reply_to_message?.message_id;
    if (questionMessageId === undefined) return;
    const pending = this.pendingPrompts.get(questionMessageId);
    if (!pending || !this.matchesConfiguredDestination(message)) return;
    const text = message?.text?.trim();
    if (!text) return;

    const parsed = /^\/cancel(?:@\w+)?$/i.test(text)
      ? { status: "cancelled" as const }
      : pending.request.parse(text);
    if (parsed.status === "rejected") {
      const correction = parsed.message ?? "That reply is not valid for this question. Please try again or send /cancel.";
      await this.api.sendMessage(correction, { replyToMessageId: message?.message_id }).catch(() => undefined);
      return;
    }
    if (parsed.status === "cancelled") {
      this.removePrompt(questionMessageId, { status: "cancelled" });
      this.track(this.api.sendMessage("⏹ Pi · Question cancelled from Telegram.", { replyToMessageId: questionMessageId }));
      return;
    }

    this.removePrompt(questionMessageId, { status: "answered", value: parsed.value });
    this.track(this.api.sendMessage(
      `✅ Pi · Reply received first on Telegram.\n\n${parsed.displayText}`,
      { replyToMessageId: questionMessageId },
    ));
  }

  private matchesConfiguredDestination(message: TelegramMessage | undefined): boolean {
    if (!message || message.from?.is_bot || typeof message.text !== "string") return false;
    if (!matchesChat(this.config.chatId, message.chat)) return false;
    if (this.config.threadId !== undefined && message.message_thread_id !== this.config.threadId) return false;
    return true;
  }

  private removePrompt<T>(messageId: number, result: TelegramPromptResult<T>): void {
    const pending = this.pendingPrompts.get(messageId) as PendingPrompt<T> | undefined;
    if (!pending) return;
    this.pendingPrompts.delete(messageId);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    pending.resolve(result);
    if (this.pendingPrompts.size === 0) this.pollController?.abort();
  }

  private rejectPrompt(messageId: number, error: unknown): void {
    const pending = this.pendingPrompts.get(messageId);
    if (!pending) return;
    this.pendingPrompts.delete(messageId);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    pending.reject(error);
    if (this.pendingPrompts.size === 0) this.pollController?.abort();
  }

  private track<T>(promise: Promise<T>): void {
    let tracked: Promise<unknown>;
    tracked = promise.catch(() => undefined).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }
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
