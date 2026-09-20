import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramApiClient } from "./api.ts";
import { BotInbox } from "./inbox.ts";
import type { TelegramConfig } from "./config.ts";

const config: TelegramConfig = { botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi", chatId: "12345", details: "summary", questionDelayMinutes: 5 };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const value = await mkdtemp(join(tmpdir(), "pi-inbox-")); roots.push(value); return value; }
const reply = (id: number) => ({ update_id: id, message: { message_id: id + 100, text: "yes", chat: { id: 12345 }, reply_to_message: { message_id: 5 } } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

test("concurrent readers share one poll and each receives the durable replies", async () => {
  const directory = await root();
  const gate = deferred<void>();
  const entered = deferred<void>();
  const bodies: any[] = [];
  const api = new TelegramApiClient(config, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    if (body.offset === -1) return Response.json({ ok: true, result: [{ update_id: 5 }] });
    entered.resolve(); await gate.promise;
    return Response.json({ ok: true, result: [reply(6), { update_id: 7, message: { text: "unrelated message" } }] });
  } });
  const first = new BotInbox(directory, config.botToken, api, 0);
  const second = new BotInbox(directory, config.botToken, api, 0);
  await Promise.all([first.initialize(), second.initialize()]);
  const signal = new AbortController().signal;
  const reading = first.read(signal);
  await entered.promise;
  expect(await second.read(signal)).toEqual([]);
  gate.resolve();
  expect((await reading).map((update: any) => update.update_id)).toEqual([6]);
  expect((await second.read(signal)).map((update: any) => update.update_id)).toEqual([6]);
  expect(bodies.map((body) => body.offset)).toEqual([-1, 6]);
  const path = join(directory, (await readdir(directory))[0]!, "replies.json");
  const stored = await readFile(path, "utf8");
  expect(stored).not.toContain(config.botToken);
  expect(stored).not.toContain("unrelated message");
  expect(JSON.parse(stored).offset).toBe(8);
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("an aborted poll releases ownership so another reader can continue", async () => {
  const directory = await root();
  const entered = deferred<void>();
  let requests = 0;
  const api = new TelegramApiClient(config, { fetch: async (_url, init) => {
    requests += 1;
    if (requests === 1) return Response.json({ ok: true, result: [] });
    if (requests === 2) {
      entered.resolve();
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    }
    return Response.json({ ok: true, result: [reply(9)] });
  } });
  const first = new BotInbox(directory, config.botToken, api, 0);
  const second = new BotInbox(directory, config.botToken, api, 0);
  await first.initialize(); await second.initialize();
  const controller = new AbortController();
  const reading = first.read(controller.signal);
  void reading.catch(() => undefined);
  await entered.promise; controller.abort(); await expect(reading).rejects.toThrow();
  expect((await second.read(new AbortController().signal)).map((item: any) => item.update_id)).toEqual([9]);
});

test("stale leases recover and unsafe reply files are rejected", async () => {
  const directory = await root();
  const api = new TelegramApiClient(config, { fetch: async () => Response.json({ ok: true, result: [] }) });
  const inbox = new BotInbox(directory, config.botToken, api, 0);
  await inbox.initialize();
  const location = join(directory, (await readdir(directory))[0]!);
  const lease = join(location, "poll.lock");
  await mkdir(lease);
  await utimes(lease, new Date(0), new Date(0));
  expect(await inbox.read(new AbortController().signal)).toEqual([]);
  if (process.platform !== "win32") {
    await chmod(join(location, "replies.json"), 0o644);
    await expect(inbox.read(new AbortController().signal)).rejects.toThrow("safely");
  }
});

test("a symlink cannot redirect the inbox into another directory", async () => {
  const directory = await root();
  const elsewhere = await root();
  const api = new TelegramApiClient(config, { fetch: async () => Response.json({ ok: true, result: [] }) });
  const inbox = new BotInbox(directory, config.botToken, api, 0);
  await inbox.initialize();
  const location = join(directory, (await readdir(directory))[0]!);
  await rm(location, { recursive: true });
  await symlink(elsewhere, location, "dir");
  const other = new BotInbox(directory, config.botToken, api, 0);
  await expect(other.initialize()).rejects.toThrow("owner-only directory");
});
