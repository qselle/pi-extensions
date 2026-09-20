import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lock } from "proper-lockfile";
import { TelegramApiClient, TelegramApiError } from "./api.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const RETENTION_MS = 10 * 60_000;
const MAX_UPDATES = 256;
interface Journal { version: 1; offset: number; updates: Array<{ at: number; update: any }> }
export interface TelegramInbox {
  initialize(signal?: AbortSignal): Promise<void>;
  read(signal: AbortSignal): Promise<unknown[]>;
}

/** A durable, bounded reply inbox shared by local processes using the same bot. */
export class BotInbox implements TelegramInbox {
  private readonly directory: string;
  private readonly path: string;
  private cursor?: number;
  private initializing?: Promise<void>;

  constructor(root: string, botToken: string, private readonly api: TelegramApiClient, private readonly pollSeconds = 20) {
    const id = createHash("sha256").update(botToken.split(":")[0]!).digest("hex");
    this.directory = join(root, id);
    this.path = join(this.directory, "replies.json");
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.cursor !== undefined) return;
    this.initializing ??= (async () => {
      await this.secureDirectory();
      while (this.cursor === undefined) {
        signal?.throwIfAborted();
        const existing = await this.load();
        if (existing) { this.cursor = existing.offset; return; }
        const controller = new AbortController();
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const release = await this.acquire(controller);
        if (!release) { await delay(100, undefined, { signal }); continue; }
        try {
          let journal = await this.load();
          if (!journal) {
            const updates = await this.api.call("getUpdates", { offset: -1, timeout: 0, allowed_updates: ["message", "callback_query"] }, { signal: combined });
            journal = { version: 1, offset: nextOffset(0, updates), updates: [] };
            combined.throwIfAborted();
            await this.save(journal);
          }
          this.cursor = journal.offset;
        } finally { await release().catch(() => undefined); }
      }
    })().finally(() => { this.initializing = undefined; });
    return this.initializing;
  }

  async read(signal: AbortSignal): Promise<unknown[]> {
    await this.initialize(signal);
    signal.throwIfAborted();
    let journal = await this.load();
    if (!journal) throw failure("Telegram reply state disappeared; restart the integration.");
    const ready = this.take(journal);
    if (ready.length) return ready;
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const release = await this.acquire(controller);
    if (!release) { await delay(100, undefined, { signal }); return []; }
    try {
      // Re-read after election so a waiting process never repeats an old offset.
      journal = (await this.load())!;
      if (!journal) throw failure("Telegram reply state disappeared; restart the integration.");
      const arrived = this.take(journal);
      if (arrived.length) return arrived;
      const updates = await this.api.call("getUpdates", {
        offset: journal.offset, timeout: this.pollSeconds, allowed_updates: ["message", "callback_query"],
      }, { signal: combined, timeoutMs: this.pollSeconds * 1000 + 5000 });
      combined.throwIfAborted();
      const now = Date.now();
      const received = Array.isArray(updates) ? updates : [];
      const fresh = received.filter((update) => Number.isSafeInteger(update?.update_id) && update.update_id >= journal!.offset)
        .map(compactReply).filter(Boolean).map((update) => ({ at: now, update }));
      journal.updates = [...journal.updates.filter((entry) => entry.at >= now - RETENTION_MS), ...fresh].slice(-MAX_UPDATES);
      journal.offset = nextOffset(journal.offset, received);
      // Persist replies before acknowledging their update IDs in the next poll.
      await this.save(journal);
      return this.take(journal);
    } finally { await release().catch(() => undefined); }
  }

  private take(journal: Journal): unknown[] {
    const updates = journal.updates.filter((entry) => entry.at >= Date.now() - RETENTION_MS && entry.update.update_id >= (this.cursor ?? 0)).map((entry) => entry.update);
    this.cursor = Math.max(this.cursor ?? 0, journal.offset);
    return updates;
  }

  private async acquire(controller: AbortController): Promise<(() => Promise<void>) | undefined> {
    try {
      // Every participant uses the same lease timing. A lost lease cancels its HTTP poll.
      return await lock(this.directory, {
        lockfilePath: join(this.directory, "poll.lock"), stale: 10_000, update: 2_000, retries: 0,
        onCompromised: () => controller.abort(),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined;
      throw failure("Telegram reply coordination is unavailable.");
    }
  }

  private async secureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stats = await lstat(this.directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || !ownerOnly(stats)) throw failure("Telegram inbox requires an owner-only directory.");
  }

  private async load(): Promise<Journal | undefined> {
    let file;
    try {
      file = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stats = await file.stat();
      if (!stats.isFile() || !ownerOnly(stats) || stats.size > MAX_BYTES) throw failure("Telegram reply state cannot be read safely.");
      const data = JSON.parse(await file.readFile("utf8"));
      if (data?.version !== 1 || !Number.isSafeInteger(data.offset) || data.offset < 0 || !Array.isArray(data.updates)
        || data.updates.length > MAX_UPDATES || data.updates.some((entry: any) => !Number.isFinite(entry.at) || !Number.isSafeInteger(entry.update?.update_id))) {
        throw failure("Telegram reply state is invalid.");
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof TelegramApiError) throw error;
      throw failure("Telegram reply state cannot be read safely.");
    } finally { await file?.close(); }
  }

  private async save(journal: Journal): Promise<void> {
    const text = JSON.stringify(journal);
    if (Buffer.byteLength(text) > MAX_BYTES) throw failure("Telegram reply buffer is full.");
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}

function nextOffset(current: number, updates: unknown): number {
  if (!Array.isArray(updates)) return current;
  return updates.reduce((offset, update) => Number.isSafeInteger(update?.update_id) ? Math.max(offset, update.update_id + 1) : offset, current);
}

function compactReply(update: any): unknown | undefined {
  const message = update.callback_query?.message ?? update.message;
  if (!message || (!update.callback_query && !Number.isSafeInteger(message.reply_to_message?.message_id))) return;
  const compact = {
    message_id: message.message_id, message_thread_id: message.message_thread_id,
    chat: { id: message.chat?.id, username: message.chat?.username }, from: { is_bot: message.from?.is_bot },
    ...(typeof message.text === "string" ? { text: [...message.text].slice(0, 4096).join("") } : {}),
    ...(message.reply_to_message ? { reply_to_message: { message_id: message.reply_to_message.message_id } } : {}),
  };
  return update.callback_query ? {
    update_id: update.update_id,
    callback_query: { id: update.callback_query.id, data: update.callback_query.data, from: { is_bot: update.callback_query.from?.is_bot }, message: compact },
  } : { update_id: update.update_id, message: compact };
}

function ownerOnly(stats: { mode: number; uid: number }): boolean {
  return process.platform === "win32" || ((stats.mode & 0o077) === 0 && stats.uid === process.getuid?.());
}

function failure(message: string): TelegramApiError { return new TelegramApiError(message, "response"); }
