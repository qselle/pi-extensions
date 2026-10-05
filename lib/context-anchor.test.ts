import { expect, test } from "bun:test";
import { contentText, createContextAnchor, visibleMessages } from "./context-anchor.ts";

const anchor = createContextAnchor<string | undefined>({
  customType: "state-anchor",
  render: (state) => state ? `State: ${state}` : "No state",
  readMessage: (message) => message.role === "toolResult" && message.toolName === "set_state" && !message.isError
    ? `State: ${(message.details as { state: string }).state}`
    : undefined,
  emptyText: "No state",
});

function session(messages: unknown[]) {
  const sent: any[] = [];
  const host = { sendMessage: (message: unknown, options: unknown) => { sent.push({ message, options }); messages.push({ role: "custom", ...message as object }); } };
  const ctx = { sessionManager: { buildSessionProjection: () => ({ messages: [...messages] }) } };
  return { host, ctx, sent };
}

test("reads plain text from string and text-only content", () => {
  expect(contentText("plain")).toBe("plain");
  expect(contentText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab");
  expect(contentText([{ type: "image", data: "" }])).toBeUndefined();
  expect(contentText(undefined)).toBeUndefined();
});

test("the newest anchor or state message wins and empty context means empty state", () => {
  expect(anchor.visibleText([])).toBe("No state");
  expect(anchor.visibleText([
    { role: "custom", customType: "state-anchor", content: "State: old" },
    { role: "toolResult", toolName: "set_state", details: { state: "new" } },
    { role: "toolResult", toolName: "set_state", isError: true, details: { state: "failed" } },
    { role: "assistant", content: [] },
  ])).toBe("State: new");
  expect(anchor.visibleText([
    { role: "toolResult", toolName: "set_state", details: { state: "new" } },
    { role: "custom", customType: "state-anchor", content: [{ type: "text", text: "No state" }] },
  ])).toBe("No state");
});

test("sync sends one hidden steer anchor only when the visible state differs", () => {
  const messages: unknown[] = [{ role: "toolResult", toolName: "set_state", details: { state: "ready" } }];
  const { host, ctx, sent } = session(messages);
  expect(anchor.sync(host, ctx, "ready")).toBe(false);
  expect(anchor.sync(host, ctx, "changed", { source: "test" })).toBe(true);
  expect(sent).toEqual([{
    message: { customType: "state-anchor", content: "State: changed", display: false, details: { source: "test" } },
    options: { deliverAs: "steer" },
  }]);
  expect(anchor.sync(host, ctx, "changed")).toBe(false);
  expect(sent).toHaveLength(1);
});

test("an empty state needs no anchor unless the model still sees an older state", () => {
  const empty = session([]);
  expect(anchor.sync(empty.host, empty.ctx, undefined)).toBe(false);
  const stale = session([{ role: "toolResult", toolName: "set_state", details: { state: "ready" } }]);
  expect(anchor.sync(stale.host, stale.ctx, undefined)).toBe(true);
  expect(stale.sent[0].message.content).toBe("No state");
});

test("without a readable projection nothing is sent", () => {
  const sent: unknown[] = [];
  const host = { sendMessage: (message: unknown) => { sent.push(message); } };
  expect(visibleMessages({ sessionManager: {} })).toBeUndefined();
  expect(anchor.sync(host, { sessionManager: {} }, "ready")).toBe(false);
  expect(anchor.sync(host, { sessionManager: { buildSessionProjection: () => { throw new Error("closed"); } } }, "ready")).toBe(false);
  expect(sent).toEqual([]);
});
