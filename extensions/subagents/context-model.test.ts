import { expect, test } from "bun:test";
import { safeParentMessages } from "./context-model.ts";

const assistantTools = (...ids: string[]) => ({
  role: "assistant",
  content: ids.map((id) => ({ type: "toolCall", id, name: "subagents", arguments: {} })),
});

test("forks before an unresolved delegating tool-call batch", () => {
  const user = { role: "user", content: "delegate research" };
  const assistant = assistantTools("spawn-a", "spawn-b");
  const messages = [user, assistant, { role: "toolResult", toolCallId: "spawn-a", content: [] }];
  expect(safeParentMessages({ messages })).toEqual([user]);
});

test("keeps fully resolved tool batches and ordinary assistant turns", () => {
  const messages = [
    { role: "user", content: "inspect" },
    assistantTools("read-1"),
    { role: "toolResult", toolCallId: "read-1", content: [] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  expect(safeParentMessages({ messages })).toEqual(messages);
});

test("does not mutate the parent context array", () => {
  const messages = [{ role: "user", content: "hello" }];
  const result = safeParentMessages({ messages });
  expect(result).toEqual(messages);
  expect(result).not.toBe(messages);
});
