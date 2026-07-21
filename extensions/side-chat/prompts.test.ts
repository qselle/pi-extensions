import { expect, test } from "bun:test";
import {
  boundedConversation,
  buildSidePreamble,
  compactText,
  deriveTitle,
  responseText,
  SIDE_BOUNDARY,
  toApiMessages,
} from "./prompts.ts";
import type { SideChat, SideModelRef } from "./types.ts";

const MODEL: SideModelRef = { provider: "openai", id: "gpt-5", api: "openai-responses" };

function chat(overrides: Partial<SideChat> = {}): SideChat {
  return {
    id: "c1",
    title: "t",
    createdAt: 1,
    updatedAt: 1,
    contextMode: "snapshot",
    model: MODEL,
    systemPrompt: "sys",
    turns: [],
    status: "idle",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    contextTruncated: false,
    ...overrides,
  };
}

test("none mode carries only the boundary and the main system prompt", () => {
  const result = buildSidePreamble({ contextMode: "none", mainSystemPrompt: "PROJECT RULES" });
  expect(result.contextTruncated).toBe(false);
  expect(result.systemPrompt.startsWith(SIDE_BOUNDARY)).toBe(true);
  expect(result.systemPrompt).toContain("PROJECT RULES");
  expect(result.systemPrompt).not.toContain("main_conversation_snapshot");
});

test("snapshot mode embeds the conversation and marks truncation", () => {
  const small = buildSidePreamble({ contextMode: "snapshot", conversation: "hello main convo" });
  expect(small.systemPrompt).toContain("<main_conversation_snapshot>");
  expect(small.systemPrompt).toContain("hello main convo");
  expect(small.contextTruncated).toBe(false);

  const huge = "x".repeat(300_000);
  const big = buildSidePreamble({ contextMode: "snapshot", conversation: huge, modelContextWindow: 8_000 });
  expect(big.contextTruncated).toBe(true);
  expect(big.systemPrompt).toContain("main conversation omitted");
});

test("boundedConversation keeps short text and head+tails long text", () => {
  expect(boundedConversation("short")).toEqual({ text: "short", truncated: false });
  const long = `HEAD${"-".repeat(500_000)}TAIL`;
  const bounded = boundedConversation(long, 4_000);
  expect(bounded.truncated).toBe(true);
  expect(bounded.text.startsWith("HEAD")).toBe(true);
  expect(bounded.text.endsWith("TAIL")).toBe(true);
  expect(bounded.text.length).toBeLessThan(long.length);
});

test("toApiMessages converts committed turns and the pending question", () => {
  const messages = toApiMessages(chat({
    turns: [
      { role: "user", text: "hi", timestamp: 1 },
      { role: "assistant", text: "hello", timestamp: 2, model: "openai/gpt-5" },
    ],
    pending: { text: "follow up", startedAt: 3 },
  }));
  expect(messages).toHaveLength(3);
  expect(messages[0]).toMatchObject({ role: "user" });
  expect(messages[1]).toMatchObject({ role: "assistant", provider: "openai", model: "gpt-5", api: "openai-responses" });
  expect(messages[2]).toMatchObject({ role: "user" });
  const pending = messages[2] as { content: Array<{ text: string }> };
  expect(pending.content[0].text).toBe("follow up");
});

test("responseText joins text parts and ignores others", () => {
  expect(responseText({ content: [
    { type: "text", text: "one" },
    { type: "thinking", thinking: "ignore" } as never,
    { type: "text", text: "two" },
  ] })).toBe("one\ntwo");
  expect(responseText({ content: [] })).toBe("");
});

test("deriveTitle uses the first sentence and truncates", () => {
  expect(deriveTitle("What is the cause? And more.")).toBe("What is the cause?");
  expect(deriveTitle("   ")).toBe("Untitled side chat");
  expect(deriveTitle("a".repeat(80), 10)).toHaveLength(10);
});

test("compactText normalizes whitespace and truncates", () => {
  expect(compactText("  a\n b  c ", 100)).toBe("a b c");
  expect(compactText("abcdef", 4)).toBe("abc…");
});
