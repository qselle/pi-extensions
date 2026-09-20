import { createHash } from "node:crypto";
import { basename } from "node:path";
import { TelegramApiClient, TelegramApiError, safeTelegramError } from "./api.ts";
import type { TelegramConfig, TelegramTopicsMode } from "./config.ts";

export const TOPIC_ENTRY = "telegram:session-topic";
interface TopicRecord {
  version: 1;
  account: string;
  sessionId: string;
  threadId?: number;
  title?: string;
  pinnedName?: string;
  mode?: TelegramTopicsMode;
  creating?: boolean;
}
export interface TopicSession {
  id: string;
  title?: string;
  cwd: string;
  entries: readonly { type: string; customType?: string; data?: unknown }[];
  save(data: unknown): void;
}
export interface TopicRoute { threadId?: number; generalTitle?: string }
interface SessionState {
  input: TopicSession;
  record: TopicRecord;
  queue: Promise<unknown>;
  status: string;
}

export function topicName(title: string | undefined, cwd: string, id: string): string {
  const value = title?.trim() || `${basename(cwd) || "Pi"} · ${id.slice(0, 8)}`;
  return [...value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim()].slice(0, 128).join("") || "Pi";
}

/** Session topics live in Pi metadata; forks cannot inherit their parent's destination. */
export class SessionTopics {
  private readonly account: string;
  private current?: SessionState;
  private supported?: Promise<boolean>;
  private readonly lifecycle = new AbortController();

  constructor(private readonly config: TelegramConfig, private readonly api: TelegramApiClient) {
    // Bot ID survives token rotation; no credential or raw recipient is persisted.
    this.account = createHash("sha256").update(`${config.botToken.split(":")[0]}\0${config.chatId.toLowerCase()}`).digest("hex");
  }

  bind(input: TopicSession): void {
    if (this.current?.input.id === input.id) {
      this.current.input = input;
      return;
    }
    let record: TopicRecord = { version: 1, account: this.account, sessionId: input.id };
    for (const entry of input.entries) {
      if (entry.type !== "custom" || entry.customType !== TOPIC_ENTRY) continue;
      const candidate = entry.data as TopicRecord | undefined;
      if (candidate?.version !== 1 || candidate.account !== this.account || candidate.sessionId !== input.id) continue;
      if (candidate.threadId !== undefined && (!Number.isSafeInteger(candidate.threadId) || candidate.threadId <= 0)) continue;
      if (candidate.title !== undefined && typeof candidate.title !== "string") continue;
      if (candidate.pinnedName !== undefined && typeof candidate.pinnedName !== "string") continue;
      if (candidate.mode !== undefined && !["auto", "required", "off"].includes(candidate.mode)) continue;
      record = { ...candidate };
    }
    this.current = { input, record, queue: Promise.resolve(), status: record.threadId ? `topic ${record.threadId}` : "waiting for the first outgoing message" };
  }

  status(): string {
    if (this.config.threadId !== undefined) return `fixed topic ${this.config.threadId} (configuration)`;
    if (!this.current) return "waiting for a Pi session";
    const state = this.current;
    const mode = state.record.mode ?? this.config.topics ?? "auto";
    return `${mode} · ${state.record.creating ? "creation unconfirmed; /telegram topic retry before another attempt" : state.status}`;
  }

  async command(args: string): Promise<string> {
    const state = this.current;
    if (!state) return this.status();
    if (this.config.threadId !== undefined) return this.status();
    const [action = "status", ...rest] = args.trim().split(/\s+/);
    if (action === "status" || !action) return this.status();
    return this.enqueue(state, async () => {
      if (["auto", "required", "off"].includes(action)) {
        state.record.mode = action as TelegramTopicsMode;
        state.status = action === "off" ? "General" : "next outgoing message will resolve its topic";
      } else if (action === "retry") {
        state.record.creating = false;
        this.supported = undefined;
        state.status = "topic discovery will retry on the next outgoing message";
      } else if (action === "new") {
        state.record.threadId = undefined;
        state.record.title = undefined;
        state.record.creating = false;
        state.status = "a fresh topic will be created on the next outgoing message";
      } else if (action === "name" && rest.length) {
        state.record.pinnedName = topicName(rest.join(" "), state.input.cwd, state.input.id);
      } else if (action === "follow") {
        state.record.pinnedName = undefined;
      } else {
        return "Usage: /telegram topic [status|auto|required|off|retry|new|name <text>|follow]";
      }
      this.save(state);
      if (action === "name" || action === "follow") {
        try { await this.rename(state, this.lifecycle.signal); }
        catch (error) { state.status = `name update failed: ${safeTelegramError(error)}`; }
      }
      return this.status();
    });
  }

  resolve(signal?: AbortSignal): Promise<TopicRoute> {
    if (this.config.threadId !== undefined) return Promise.resolve({ threadId: this.config.threadId });
    const state = this.current;
    if (!state) return Promise.resolve({});
    const combined = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    return this.enqueue(state, async () => {
      combined.throwIfAborted();
      const mode = state.record.mode ?? this.config.topics ?? "auto";
      const title = this.name(state);
      if (mode === "off") return { generalTitle: title };
      if (state.record.threadId === undefined) {
        if (state.record.creating) throw new TelegramApiError("Topic creation is unconfirmed; use /telegram topic retry after checking Telegram.", "response");
        const supported = await this.supportsTopics(combined);
        combined.throwIfAborted();
        if (!supported) {
          state.status = "General: topics are not enabled for this destination";
          if (mode === "required") throw new TelegramApiError("Enable Telegram topics or select /telegram topic auto to allow General.", "rejected");
          return { generalTitle: title };
        }
        // Persist before requesting creation: a lost response must not silently
        // create duplicate topics on reload. Retrying requires an explicit command.
        state.record.creating = true;
        this.save(state);
        const result = await this.api.call("createForumTopic", { chat_id: this.config.chatId, name: title }, { signal: combined });
        if (!Number.isSafeInteger(result?.message_thread_id) || result.message_thread_id <= 0) {
          throw new TelegramApiError("Telegram did not confirm a valid session topic.", "response");
        }
        state.record.threadId = result.message_thread_id;
        state.record.title = title;
        state.record.creating = false;
        this.save(state);
      }
      try { await this.rename(state, combined); }
      catch (error) {
        combined.throwIfAborted();
        state.status = `topic ${state.record.threadId}; name update failed: ${safeTelegramError(error)}`;
        return { threadId: state.record.threadId };
      }
      state.status = `topic ${state.record.threadId} · ${state.record.title}`;
      return { threadId: state.record.threadId };
    });
  }

  syncName(): Promise<void> {
    const state = this.current;
    if (!state?.record.threadId || (state.record.mode ?? this.config.topics) === "off") return Promise.resolve();
    return this.enqueue(state, async () => {
      try { await this.rename(state, this.lifecycle.signal); }
      catch (error) { state.status = `topic ${state.record.threadId}; name update failed: ${safeTelegramError(error)}`; }
    });
  }

  shutdown(): void { this.lifecycle.abort(); }

  private name(state: SessionState): string {
    return state.record.pinnedName ?? topicName(state.input.title, state.input.cwd, state.input.id);
  }

  private save(state: SessionState): void {
    // A late request for an old session must never append its mapping to the new one.
    if (this.current === state) state.input.save(structuredClone(state.record));
  }

  private async rename(state: SessionState, signal: AbortSignal): Promise<void> {
    const title = this.name(state);
    if (!state.record.threadId || title === state.record.title) return;
    await this.api.call("editForumTopic", {
      chat_id: this.config.chatId, message_thread_id: state.record.threadId, name: title,
    }, { signal });
    state.record.title = title;
    state.status = `topic ${state.record.threadId} · ${title}`;
    this.save(state);
  }

  private supportsTopics(signal: AbortSignal): Promise<boolean> {
    this.supported ??= (/^[1-9]\d*$/.test(this.config.chatId)
      ? this.api.call("getMe", {}, { signal }).then((bot) => bot?.has_topics_enabled === true)
      : this.api.call("getChat", { chat_id: this.config.chatId }, { signal }).then((chat) => chat?.is_forum === true)
    ).catch((error) => { this.supported = undefined; throw error; });
    return this.supported;
  }

  private enqueue<T>(state: SessionState, operation: () => Promise<T>): Promise<T> {
    const pending = state.queue.catch(() => undefined).then(operation);
    state.queue = pending;
    return pending;
  }
}
