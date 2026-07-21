import { deriveTitle } from "./prompts.ts";
import { addSideUsage, emptySideUsage } from "./usage.ts";
import {
  DEFAULT_SIDE_CHAT_TITLE,
  modelLabel,
  type SideChat,
  type SideContextMode,
  type SideModelRef,
  type SideUsage,
} from "./types.ts";

/** Result of a single background generation. */
export interface SideRunResult {
  text: string;
  usage?: SideUsage;
}

/**
 * Runs one model turn for a chat. Reads the chat's current messages/pending
 * question, honors the abort signal, and returns the answer plus usage.
 * Throwing (or an aborted signal) marks the turn failed.
 */
export type SideRunModel = (chat: SideChat, signal: AbortSignal) => Promise<SideRunResult>;

export interface SideChatHooks {
  /** Fired after any observable state change (for UI refresh). */
  onChange?: () => void;
  /** Persist immutable chat metadata (once, at creation). */
  persistMeta?: (chat: SideChat) => void;
  /** Persist mutable chat state (turns, title, usage, status). */
  persistState?: (chat: SideChat) => void;
  /** Persist a deletion tombstone for a removed chat. */
  persistDelete?: (chat: SideChat) => void;
}

export interface SideChatStoreOptions {
  runModel: SideRunModel;
  hooks?: SideChatHooks;
  now?: () => number;
  newId?: () => string;
  /** Maximum committed turns retained per chat (older pairs are dropped). */
  maxTurns?: number;
}

export interface CreateChatOptions {
  model: SideModelRef;
  systemPrompt: string;
  contextMode: SideContextMode;
  contextTruncated?: boolean;
  title?: string;
}

const DEFAULT_MAX_TURNS = 60;

/**
 * In-memory registry of side chats. Generation runs in the background with an
 * independent AbortController per chat, so a chat never touches the main agent
 * turn and multiple chats can generate concurrently.
 */
export class SideChatStore {
  private readonly chats = new Map<string, SideChat>();
  private readonly order: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly runModel: SideRunModel;
  private readonly hooks: SideChatHooks;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly maxTurns: number;

  constructor(options: SideChatStoreOptions) {
    this.runModel = options.runModel;
    this.hooks = options.hooks ?? {};
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? defaultId;
    this.maxTurns = Math.max(2, options.maxTurns ?? DEFAULT_MAX_TURNS);
  }

  /** All chats in stable creation order. */
  list(): SideChat[] {
    return this.order.map((id) => this.chats.get(id)).filter((chat): chat is SideChat => Boolean(chat));
  }

  get(id: string): SideChat | undefined {
    return this.chats.get(id);
  }

  count(): number {
    return this.chats.size;
  }

  activeCount(): number {
    return this.list().filter((chat) => chat.status === "generating").length;
  }

  isGenerating(id: string): boolean {
    return this.chats.get(id)?.status === "generating";
  }

  totalUsage(): SideUsage {
    return this.list().reduce((total, chat) => addSideUsage(total, chat.usage), emptySideUsage());
  }

  create(options: CreateChatOptions): SideChat {
    const timestamp = this.now();
    const chat: SideChat = {
      id: this.newId(),
      title: normalizeTitle(options.title) ?? DEFAULT_SIDE_CHAT_TITLE,
      createdAt: timestamp,
      updatedAt: timestamp,
      contextMode: options.contextMode,
      model: options.model,
      systemPrompt: options.systemPrompt,
      turns: [],
      status: "idle",
      usage: emptySideUsage(),
      contextTruncated: Boolean(options.contextTruncated),
    };
    this.chats.set(chat.id, chat);
    this.order.push(chat.id);
    this.hooks.persistMeta?.(chat);
    this.hooks.persistState?.(chat);
    this.change();
    return chat;
  }

  /** Queue a follow-up question and start a background generation. */
  send(id: string, text: string): boolean {
    const chat = this.chats.get(id);
    if (!chat || chat.status === "generating") return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (chat.turns.length === 0 && chat.title === DEFAULT_SIDE_CHAT_TITLE) {
      chat.title = deriveTitle(trimmed);
    }
    chat.pending = { text: trimmed, startedAt: this.now() };
    chat.status = "generating";
    chat.error = undefined;
    chat.updatedAt = this.now();
    this.persistState(chat);
    this.change();
    this.run(chat);
    return true;
  }

  /** Retry a failed generation using the still-pending question. */
  retry(id: string): boolean {
    const chat = this.chats.get(id);
    if (!chat || chat.status === "generating" || !chat.pending) return false;
    chat.status = "generating";
    chat.error = undefined;
    chat.updatedAt = this.now();
    this.persistState(chat);
    this.change();
    this.run(chat);
    return true;
  }

  /** Abort an in-flight generation, discarding the pending question. */
  abort(id: string): void {
    const controller = this.controllers.get(id);
    if (controller) controller.abort();
  }

  rename(id: string, title: string): void {
    const chat = this.chats.get(id);
    const normalized = normalizeTitle(title);
    if (!chat || !normalized || chat.title === normalized) return;
    chat.title = normalized;
    chat.updatedAt = this.now();
    this.persistState(chat);
    this.change();
  }

  /** Remove a chat, aborting any generation and writing a tombstone. */
  remove(id: string): void {
    const chat = this.chats.get(id);
    if (!chat) return;
    this.abort(id);
    this.chats.delete(id);
    const index = this.order.indexOf(id);
    if (index >= 0) this.order.splice(index, 1);
    this.hooks.persistDelete?.(chat);
    this.change();
  }

  /** Replace all chats (used to restore a branch). Aborts live generations. */
  replaceAll(chats: readonly SideChat[]): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.chats.clear();
    this.order.length = 0;
    for (const chat of chats) {
      const normalized = normalizeRestored(chat);
      this.chats.set(normalized.id, normalized);
      this.order.push(normalized.id);
    }
    this.change();
  }

  /** Abort every generation (used on shutdown). Does not clear chats. */
  stopAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  private run(chat: SideChat): void {
    const controller = new AbortController();
    this.controllers.set(chat.id, controller);
    void this.runModel(chat, controller.signal).then(
      (result) => this.settle(chat.id, controller, () => this.applySuccess(chat.id, result)),
      (error) => this.settle(chat.id, controller, () => this.applyFailure(chat.id, error, controller.signal.aborted)),
    );
  }

  /** Apply a result only if this controller is still the active one for the chat. */
  private settle(id: string, controller: AbortController, apply: () => void): void {
    if (this.controllers.get(id) !== controller) return;
    this.controllers.delete(id);
    apply();
  }

  private applySuccess(id: string, result: SideRunResult): void {
    const chat = this.chats.get(id);
    if (!chat || !chat.pending) return;
    const timestamp = this.now();
    chat.turns.push({ role: "user", text: chat.pending.text, timestamp: chat.pending.startedAt });
    chat.turns.push({
      role: "assistant",
      text: result.text,
      timestamp,
      model: modelLabel(chat.model),
      usage: result.usage,
    });
    trimTurns(chat, this.maxTurns);
    chat.pending = undefined;
    chat.status = "idle";
    chat.error = undefined;
    if (result.usage) chat.usage = addSideUsage(chat.usage, result.usage);
    chat.updatedAt = timestamp;
    this.persistState(chat);
    this.change();
  }

  private applyFailure(id: string, error: unknown, aborted: boolean): void {
    const chat = this.chats.get(id);
    if (!chat) return;
    if (aborted) {
      chat.pending = undefined;
      chat.status = "idle";
      chat.error = undefined;
    } else {
      chat.status = "error";
      chat.error = errorMessage(error);
    }
    chat.updatedAt = this.now();
    this.persistState(chat);
    this.change();
  }

  private persistState(chat: SideChat): void {
    this.hooks.persistState?.(chat);
  }

  private change(): void {
    this.hooks.onChange?.();
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || "Side chat request failed";
  return typeof error === "string" && error.trim() ? error : "Side chat request failed";
}

function trimTurns(chat: SideChat, maxTurns: number): void {
  if (chat.turns.length <= maxTurns) return;
  // Drop the oldest complete user/assistant pairs, keeping alternation intact.
  const excess = chat.turns.length - maxTurns;
  const drop = excess % 2 === 0 ? excess : excess + 1;
  chat.turns.splice(0, Math.min(drop, chat.turns.length));
}

function normalizeTitle(title: string | undefined): string | undefined {
  const normalized = title?.replace(/\s+/g, " ").trim();
  return normalized ? normalized : undefined;
}

/** A restored chat can never be mid-generation; normalize transient state. */
function normalizeRestored(chat: SideChat): SideChat {
  if (chat.status === "generating") {
    return { ...chat, status: "idle", pending: undefined };
  }
  return chat;
}

function defaultId(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID();
  return `side-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
