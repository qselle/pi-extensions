import { expect, test } from "bun:test";
import { TelegramApiClient, TelegramApiError } from "./api.ts";
import { createHash } from "node:crypto";
import { LEGACY_TOPIC_ENTRY, SessionTopics, TOPIC_ENTRY, topicName } from "./topics.ts";
import type { TelegramConfig } from "./config.ts";

const config: TelegramConfig = { botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi", chatId: "12345", details: "summary", questionDelayMinutes: 5 };
function setup(overrides: Partial<TelegramConfig> = {}, restored: any[] = []) {
  const entries = structuredClone(restored);
  const calls: { method: string; body: any }[] = [];
  let next = 100;
  let supported = true;
  let failure: string | undefined;
  let wait: Promise<void> | undefined;
  const api = new TelegramApiClient({ ...config, ...overrides }, { fetch: async (url, init) => {
    const method = String(url).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body));
    calls.push({ method, body });
    if (method === "createForumTopic") await wait;
    if (method === failure) throw new Error("private network detail");
    const result = method === "getMe" ? { has_topics_enabled: supported }
      : method === "getChat" ? { is_forum: supported }
      : method === "createForumTopic" ? { message_thread_id: next++ } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  } });
  const topics = new SessionTopics({ ...config, ...overrides }, api);
  const bind = (id = "session-a", title = "First Session", target = entries) => topics.bind({
    id, title, cwd: "/project", entries: target,
    save: (data) => target.push({ type: "custom", customType: TOPIC_ENTRY, data }),
  });
  bind();
  return { topics, bind, entries, calls, support: (value: boolean) => { supported = value; }, fail: (method?: string) => { failure = method; }, wait: (value: Promise<void>) => { wait = value; } };
}

test("creates lazily once for concurrent outgoing messages and saves no credentials", async () => {
  const h = setup();
  expect(h.calls).toHaveLength(0);
  const routes = await Promise.all([h.topics.resolve(), h.topics.resolve(), h.topics.resolve()]);
  expect(routes).toEqual([{ threadId: 100 }, { threadId: 100 }, { threadId: 100 }]);
  expect(h.calls.map((call) => call.method)).toEqual(["getMe", "createForumTopic"]);
  expect(JSON.stringify(h.entries)).not.toContain(config.botToken);
  expect(JSON.stringify(h.entries)).not.toContain(config.chatId);
});

test("resume and token rotation reuse a topic; forks and recipient changes do not", async () => {
  const first = setup();
  await first.topics.resolve();
  const resumed = setup({ botToken: "123456789:ROTATED_CREDENTIAL" }, first.entries);
  expect(await resumed.topics.resolve()).toEqual({ threadId: 100 });
  expect(resumed.calls).toHaveLength(0);
  resumed.bind("fork-b", "Fork", resumed.entries);
  await resumed.topics.resolve();
  expect(resumed.calls.map((call) => call.method)).toEqual(["getMe", "createForumTopic"]);
  const other = setup({ chatId: "98765" }, first.entries);
  await other.topics.resolve();
  expect(other.calls.map((call) => call.method)).toEqual(["getMe", "createForumTopic"]);
});

test("fixed destinations and off mode never probe or create topics", async () => {
  const fixed = setup({ threadId: 42 });
  expect(await fixed.topics.resolve()).toEqual({ threadId: 42 });
  expect(await fixed.topics.command("name Changed")).toContain("configuration");
  expect(fixed.calls).toHaveLength(0);
  const off = setup({ topics: "off" });
  expect(await off.topics.resolve()).toEqual({ generalTitle: "First Session" });
  expect(off.calls).toHaveLength(0);
});

test("fixed destination configuration does not rename a previously automatic topic", async () => {
  const original = setup();
  await original.topics.resolve();
  const fixed = setup({ threadId: 42 }, original.entries);
  fixed.bind("session-a", "New session name");
  await fixed.topics.syncName();
  expect(await fixed.topics.resolve()).toEqual({ threadId: 42 });
  expect(fixed.calls).toHaveLength(0);
});

test("private and group capability discovery allows General only when configured", async () => {
  const h = setup();
  h.support(false);
  expect(await h.topics.resolve()).toEqual({ generalTitle: "First Session" });
  await h.topics.command("required");
  await expect(h.topics.resolve()).rejects.toThrow("Enable Telegram topics");
  h.support(true);
  await h.topics.command("retry");
  expect(await h.topics.resolve()).toEqual({ threadId: 100 });
  const group = setup({ chatId: "-100123" });
  await group.topics.resolve();
  expect(group.calls[0]?.method).toBe("getChat");
});

test("lost creation responses require explicit retry, including after reload", async () => {
  const h = setup();
  h.fail("createForumTopic");
  await expect(h.topics.resolve()).rejects.toBeInstanceOf(TelegramApiError);
  h.fail();
  await expect(h.topics.resolve()).rejects.toThrow("unconfirmed");
  expect(h.calls.filter((call) => call.method === "createForumTopic")).toHaveLength(1);
  const resumed = setup({}, h.entries);
  await expect(resumed.topics.resolve()).rejects.toThrow("unconfirmed");
  await resumed.topics.command("retry");
  expect(await resumed.topics.resolve()).toEqual({ threadId: 100 });
});

test("topic names follow session titles unless pinned, and rename failure does not reroute delivery", async () => {
  const h = setup();
  await h.topics.resolve();
  h.bind("session-a", "Revised Title");
  await h.topics.syncName();
  expect(h.calls.at(-1)).toEqual({ method: "editForumTopic", body: { chat_id: "12345", message_thread_id: 100, name: "Revised Title" } });
  await h.topics.command("name My Stable Topic");
  const edits = h.calls.length;
  h.bind("session-a", "Another Pi Title");
  await h.topics.syncName();
  expect(h.calls).toHaveLength(edits);
  await h.topics.command("follow");
  expect(h.calls.at(-1)?.body.name).toBe("Another Pi Title");
  h.bind("session-a", "Failed Rename");
  h.fail("editForumTopic");
  expect(await h.topics.resolve()).toEqual({ threadId: 100 });
  expect(h.topics.status()).toContain("name update failed");
});

test("a session switch cannot persist a late topic result into the new session", async () => {
  const h = setup();
  let finish!: () => void;
  h.wait(new Promise<void>((resolve) => { finish = resolve; }));
  const pending = h.topics.resolve();
  while (!h.calls.some((call) => call.method === "createForumTopic")) await new Promise((resolve) => setTimeout(resolve, 0));
  const other: any[] = [];
  h.bind("session-b", "Second Session", other);
  finish();
  expect(await pending).toEqual({ threadId: 100 });
  expect(other).toHaveLength(0);
  expect(await h.topics.resolve()).toEqual({ threadId: 101 });
  expect(other.at(-1)?.data.sessionId).toBe("session-b");
});

test("topic labels are bounded and unnamed sessions have a distinct local label", () => {
  expect(topicName(undefined, "/projects/alpha", "abcdef1234")).toBe("alpha · abcdef12");
  expect(topicName("A\nB\x07", "/", "id")).toBe("A B");
  expect([...topicName("🚀".repeat(180), "/", "id")]).toHaveLength(128);
});

const legacyKey = (token = config.botToken, chatId = config.chatId) =>
  createHash("sha256").update(`${token}\0${chatId}`).digest("hex").slice(0, 24);
const legacyEntry = (data: Record<string, unknown>) => ({
  type: "custom", customType: LEGACY_TOPIC_ENTRY,
  data: { version: 1, sessionId: "session-a", configKey: legacyKey(), messageThreadId: 77, name: "First Session", ...data },
});

test("resume reuses a topic recorded by the earlier notification integration", async () => {
  const h = setup({}, [legacyEntry({})]);
  expect(h.topics.status()).toContain("topic 77");
  expect(await h.topics.resolve()).toEqual({ threadId: 77 });
  expect(h.calls).toHaveLength(0);

  const renamed = setup({}, [legacyEntry({ name: "Old Label" })]);
  expect(await renamed.topics.resolve()).toEqual({ threadId: 77 });
  expect(renamed.calls).toEqual([{ method: "editForumTopic", body: { chat_id: "12345", message_thread_id: 77, name: "First Session" } }]);
  expect(renamed.entries.at(-1)).toMatchObject({ customType: TOPIC_ENTRY, data: { threadId: 77, title: "First Session" } });
});

test("legacy topic records must match the session, bot credentials and recipient", async () => {
  for (const data of [
    { sessionId: "other-session" },
    { configKey: legacyKey(config.botToken, "98765") },
    { configKey: legacyKey("123456789:ROTATED_CREDENTIAL") },
    { messageThreadId: 0 },
    { name: 7 },
    { version: 2 },
  ]) {
    const h = setup({}, [legacyEntry(data)]);
    expect(await h.topics.resolve()).toEqual({ threadId: 100 });
    expect(h.calls.map((call) => call.method)).toEqual(["getMe", "createForumTopic"]);
  }
});

test("a newer native mapping takes precedence over an older legacy record", async () => {
  const first = setup();
  await first.topics.command("new");
  const native = { type: "custom", customType: TOPIC_ENTRY, data: { ...first.entries.at(-1).data, threadId: 55, title: "First Session" } };
  const h = setup({}, [legacyEntry({}), native]);
  expect(await h.topics.resolve()).toEqual({ threadId: 55 });
  const reversed = setup({}, [native, legacyEntry({})]);
  expect(await reversed.topics.resolve()).toEqual({ threadId: 77 });
});
