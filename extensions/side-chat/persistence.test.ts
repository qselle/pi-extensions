import { expect, test } from "bun:test";
import {
  metaRecord,
  restoreSideChats,
  SIDE_META_ENTRY,
  SIDE_STATE_ENTRY,
  stateRecord,
} from "./persistence.ts";
import type { SideChat, SideModelRef } from "./types.ts";

const MODEL: SideModelRef = { provider: "anthropic", id: "claude", api: "anthropic-messages", contextWindow: 200_000 };

function chat(overrides: Partial<SideChat> = {}): SideChat {
  return {
    id: "c1",
    title: "debug 500",
    createdAt: 100,
    updatedAt: 200,
    contextMode: "snapshot",
    model: MODEL,
    systemPrompt: "boundary + snapshot",
    turns: [
      { role: "user", text: "why 500?", timestamp: 101 },
      { role: "assistant", text: "CSRF", timestamp: 102, model: "anthropic/claude", usage: usage() },
    ],
    status: "idle",
    usage: usage(),
    contextTruncated: true,
    ...overrides,
  };
}

function metaEntry(c: SideChat) {
  return { type: "custom", customType: SIDE_META_ENTRY, data: metaRecord(c) };
}
function stateEntry(c: SideChat, deleted = false) {
  return { type: "custom", customType: SIDE_STATE_ENTRY, data: stateRecord(c, deleted) };
}

test("round-trips a chat through meta + state entries", () => {
  const c = chat();
  const restored = restoreSideChats([metaEntry(c), stateEntry(c)]);
  expect(restored).toHaveLength(1);
  expect(restored[0]).toMatchObject({
    id: "c1",
    title: "debug 500",
    contextMode: "snapshot",
    systemPrompt: "boundary + snapshot",
    contextTruncated: true,
  });
  expect(restored[0].turns).toHaveLength(2);
  expect(restored[0].model.provider).toBe("anthropic");
});

test("the latest state entry wins", () => {
  const c = chat();
  const later = chat({ title: "renamed", updatedAt: 500 });
  const restored = restoreSideChats([metaEntry(c), stateEntry(c), stateEntry(later)]);
  expect(restored[0].title).toBe("renamed");
});

test("a deleted state acts as a tombstone", () => {
  const c = chat();
  const restored = restoreSideChats([metaEntry(c), stateEntry(c), stateEntry(c, true)]);
  expect(restored).toHaveLength(0);
});

test("generating status is normalized to idle and pending is dropped on restore", () => {
  const c = chat({ status: "generating", pending: { text: "in flight", startedAt: 1 } });
  const restored = restoreSideChats([metaEntry(c), stateEntry(c)]);
  expect(restored[0].status).toBe("idle");
  expect(restored[0].pending).toBeUndefined();
});

test("error status keeps the pending question for retry", () => {
  const c = chat({ status: "error", error: "boom", pending: { text: "retry me", startedAt: 1 } });
  const restored = restoreSideChats([metaEntry(c), stateEntry(c)]);
  expect(restored[0].status).toBe("error");
  expect(restored[0].error).toBe("boom");
  expect(restored[0].pending?.text).toBe("retry me");
});

test("chats are ordered by creation time", () => {
  const a = chat({ id: "a", createdAt: 300 });
  const b = chat({ id: "b", createdAt: 100 });
  const restored = restoreSideChats([metaEntry(a), stateEntry(a), metaEntry(b), stateEntry(b)]);
  expect(restored.map((c) => c.id)).toEqual(["b", "a"]);
});

test("ignores unrelated and malformed entries", () => {
  const c = chat();
  const restored = restoreSideChats([
    { type: "message", message: { role: "user" } },
    { type: "custom", customType: "something-else", data: {} },
    { type: "custom", customType: SIDE_META_ENTRY, data: { version: 2, id: "x" } },
    { type: "custom", customType: SIDE_META_ENTRY, data: { version: 1, id: "no-model" } },
    metaEntry(c),
    stateEntry(c),
    null,
    "garbage",
  ]);
  expect(restored.map((r) => r.id)).toEqual(["c1"]);
});

test("a chat with meta but no state entry still restores with defaults", () => {
  const c = chat();
  const restored = restoreSideChats([metaEntry(c)]);
  expect(restored).toHaveLength(1);
  expect(restored[0].turns).toHaveLength(0);
  expect(restored[0].title).toBe("New side chat");
});

function usage() {
  return { input: 5, output: 7, cacheRead: 0, cacheWrite: 0, cost: 0.02 };
}
