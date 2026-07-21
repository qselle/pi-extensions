import { expect, test } from "bun:test";
import { SideChatStore, type SideRunResult } from "./store.ts";
import type { SideChat, SideModelRef } from "./types.ts";

const MODEL: SideModelRef = { provider: "anthropic", id: "claude", api: "anthropic-messages" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: { maxTurns?: number } = {}) {
  const calls: Array<{ chat: SideChat; signal: AbortSignal; deferred: ReturnType<typeof deferred<SideRunResult>> }> = [];
  let changes = 0;
  const meta: SideChat[] = [];
  const state: SideChat[] = [];
  const deletes: SideChat[] = [];
  let clock = 1_000;
  let counter = 0;
  const store = new SideChatStore({
    maxTurns: options.maxTurns,
    now: () => ++clock,
    newId: () => `chat-${++counter}`,
    runModel: (chat, signal) => {
      const d = deferred<SideRunResult>();
      const record = { chat, signal, deferred: d };
      calls.push(record);
      signal.addEventListener("abort", () => d.reject(new Error("Side chat cancelled")));
      return d.promise;
    },
    hooks: {
      onChange: () => {
        changes += 1;
      },
      persistMeta: (chat) => meta.push(structuredClone(chat)),
      persistState: (chat) => state.push(structuredClone(chat)),
      persistDelete: (chat) => deletes.push(structuredClone(chat)),
    },
  });
  return { store, calls, meta, state, deletes, changes: () => changes };
}

function baseChat() {
  return { model: MODEL, systemPrompt: "boundary", contextMode: "snapshot" as const, title: "debug 500" };
}

test("create registers a chat and persists meta plus initial state", () => {
  const h = harness();
  const chat = h.store.create(baseChat());
  expect(chat.id).toBe("chat-1");
  expect(chat.title).toBe("debug 500");
  expect(h.store.list()).toHaveLength(1);
  expect(h.meta).toHaveLength(1);
  expect(h.state).toHaveLength(1);
  expect(h.changes()).toBeGreaterThan(0);
});

test("auto-names a chat from the first question when it has no explicit title", () => {
  const h = harness();
  const chat = h.store.create({ model: MODEL, systemPrompt: "b", contextMode: "none" });
  expect(chat.title).toBe("New side chat");
  h.store.send(chat.id, "tell me about the size of the moon");
  expect(h.store.get(chat.id)!.title).toBe("tell me about the size of the moon");
});

test("keeps an explicit title when the first question is sent", () => {
  const h = harness();
  const chat = h.store.create({ model: MODEL, systemPrompt: "b", contextMode: "none", title: "moon facts" });
  h.store.send(chat.id, "tell me about the size of the moon");
  expect(h.store.get(chat.id)!.title).toBe("moon facts");
});

test("send generates in the background and commits a user/assistant pair", async () => {
  const h = harness();
  const chat = h.store.create(baseChat());
  expect(h.store.send(chat.id, "what causes the 500?")).toBe(true);

  const live = h.store.get(chat.id)!;
  expect(live.status).toBe("generating");
  expect(live.pending?.text).toBe("what causes the 500?");
  expect(h.calls).toHaveLength(1);

  h.calls[0].deferred.resolve({ text: "Missing CSRF token.", usage: usage(10, 20) });
  await flush();

  const done = h.store.get(chat.id)!;
  expect(done.status).toBe("idle");
  expect(done.pending).toBeUndefined();
  expect(done.turns).toHaveLength(2);
  expect(done.turns[0]).toMatchObject({ role: "user", text: "what causes the 500?" });
  expect(done.turns[1]).toMatchObject({ role: "assistant", text: "Missing CSRF token.", model: "anthropic/claude" });
  expect(done.usage.input).toBe(10);
  expect(done.usage.output).toBe(20);
});

test("multiple chats generate concurrently and independently", async () => {
  const h = harness();
  const a = h.store.create(baseChat());
  const b = h.store.create({ ...baseChat(), title: "regex idea" });
  h.store.send(a.id, "q1");
  h.store.send(b.id, "q2");
  expect(h.store.activeCount()).toBe(2);

  h.calls[1].deferred.resolve({ text: "B answer" });
  await flush();
  expect(h.store.get(b.id)!.status).toBe("idle");
  expect(h.store.get(a.id)!.status).toBe("generating");

  h.calls[0].deferred.resolve({ text: "A answer" });
  await flush();
  expect(h.store.activeCount()).toBe(0);
});

test("send is ignored while a chat is already generating", () => {
  const h = harness();
  const chat = h.store.create(baseChat());
  expect(h.store.send(chat.id, "first")).toBe(true);
  expect(h.store.send(chat.id, "second")).toBe(false);
  expect(h.calls).toHaveLength(1);
});

test("a failed generation records the error and keeps the pending question", async () => {
  const h = harness();
  const chat = h.store.create(baseChat());
  h.store.send(chat.id, "why?");
  h.calls[0].deferred.reject(new Error("boom"));
  await flush();

  const failed = h.store.get(chat.id)!;
  expect(failed.status).toBe("error");
  expect(failed.error).toBe("boom");
  expect(failed.pending?.text).toBe("why?");
  expect(failed.turns).toHaveLength(0);

  // Retry reuses the pending question and can succeed.
  expect(h.store.retry(chat.id)).toBe(true);
  expect(h.calls).toHaveLength(2);
  h.calls[1].deferred.resolve({ text: "Because." });
  await flush();
  const recovered = h.store.get(chat.id)!;
  expect(recovered.status).toBe("idle");
  expect(recovered.turns.map((turn) => turn.text)).toEqual(["why?", "Because."]);
});

test("abort discards the pending question and returns the chat to idle", async () => {
  const h = harness();
  const chat = h.store.create(baseChat());
  h.store.send(chat.id, "cancel me");
  h.store.abort(chat.id);
  await flush();
  const aborted = h.store.get(chat.id)!;
  expect(aborted.status).toBe("idle");
  expect(aborted.pending).toBeUndefined();
  expect(aborted.turns).toHaveLength(0);
});

test("a late result from a superseded generation is ignored", async () => {
  const h = harness();
  const chat = h.store.create(baseChat());
  h.store.send(chat.id, "first");
  const stale = h.calls[0];
  h.store.abort(chat.id);
  await flush();

  h.store.send(chat.id, "second");
  // The stale (aborted) generation resolves after a new send started.
  stale.deferred.resolve({ text: "stale answer" });
  await flush();

  const live = h.store.get(chat.id)!;
  expect(live.status).toBe("generating");
  expect(live.pending?.text).toBe("second");
  expect(live.turns).toHaveLength(0);
});

test("remove writes a tombstone and drops the chat", () => {
  const h = harness();
  const chat = h.store.create(baseChat());
  h.store.remove(chat.id);
  expect(h.store.list()).toHaveLength(0);
  expect(h.deletes.at(-1)).toMatchObject({ id: chat.id });
});

test("replaceAll normalizes a restored generating chat to idle", () => {
  const h = harness();
  const restored: SideChat = {
    id: "restored-1",
    title: "restored",
    createdAt: 1,
    updatedAt: 2,
    contextMode: "none",
    model: MODEL,
    systemPrompt: "b",
    turns: [],
    pending: { text: "in flight", startedAt: 1 },
    status: "generating",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
    contextTruncated: false,
  };
  h.store.replaceAll([restored]);
  const chat = h.store.get("restored-1")!;
  expect(chat.status).toBe("idle");
  expect(chat.pending).toBeUndefined();
  expect(h.store.totalUsage()).toMatchObject({ input: 1, output: 2, cost: 0.1 });
});

test("history is capped to maxTurns, preserving alternation", async () => {
  const h = harness({ maxTurns: 4 });
  const chat = h.store.create(baseChat());
  for (let i = 0; i < 3; i++) {
    h.store.send(chat.id, `q${i}`);
    h.calls[i].deferred.resolve({ text: `a${i}` });
    await flush();
  }
  const live = h.store.get(chat.id)!;
  expect(live.turns).toHaveLength(4);
  expect(live.turns[0]).toMatchObject({ role: "user", text: "q1" });
  expect(live.turns.at(-1)).toMatchObject({ role: "assistant", text: "a2" });
});

function usage(input: number, output: number) {
  return { input, output, cacheRead: 0, cacheWrite: 0, cost: 0.01 };
}
