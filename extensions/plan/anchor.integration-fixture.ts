import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import planExtension from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
const manager = SessionManager.inMemory(process.cwd());
const handlers = new Map<string, Handler[]>();
const tools = new Map<string, any>();
const commands = new Map<string, any>();
const pi = {
  on: (name: string, handler: Handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand: (name: string, command: any) => commands.set(name, command),
  appendEntry: (customType: string, data: unknown) => manager.appendCustomEntry(customType, data),
  sendMessage: (message: any) => manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details),
  events: { on: () => () => {}, emit: () => {} },
};
planExtension(pi as any);
const ctx = { mode: "rpc", hasUI: false, sessionManager: manager, ui: { notify() {}, confirm: async () => true } };
const fire = async (name: string, event: object = {}) => {
  for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: unknown[]) => manager.appendMessage({ role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "fixture", usage, stopReason: "stop", timestamp: 1 } as any);
const user = (text: string) => manager.appendMessage({ role: "user", content: text, timestamp: 1 });
const update = async (id: string, args: object) => {
  assistant([{ type: "toolCall", id, name: "update_plan", arguments: args }]);
  const result = await tools.get("update_plan").execute(id, args, undefined, undefined, ctx);
  manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "update_plan", content: result.content, details: result.details, isError: false, timestamp: 1 } as any);
};
/** Messages one provider request would receive after every context hook. */
const request = async () => {
  let messages: any[] = manager.buildSessionContext().messages;
  for (const handler of handlers.get("context") ?? []) {
    const result = await handler({ type: "context", messages }, ctx) as { messages?: any[] } | undefined;
    if (result?.messages) messages = result.messages;
  }
  return messages;
};
const anchors = () => manager.getEntries().filter((entry: any) => entry.type === "custom_message" && entry.customType === "plan-context") as any[];
const plan = (current: number) => ({
  plan: ["Inspect", "Implement", "Verify"].map((step, index) => ({ step, status: index < current ? "completed" : index === current ? "in_progress" : "pending" })),
});

await fire("session_start", { reason: "startup" });
assert.equal(anchors().length, 0, "an empty session needs no anchor");
user("Build the feature");
const firstKept = manager.getLeafId()!;
await update("call-1", plan(1));

// Steady state: every request extends the previous one and ends with real conversation.
let previous: any[] | undefined;
for (let turn = 0; turn < 4; turn++) {
  const messages = await request();
  assert(messages.every((message) => message.customType !== "plan-context"), "requests carry no injected plan message");
  assert.notEqual(messages.at(-1)?.customType, "plan-context");
  if (previous) assert.deepEqual(messages.slice(0, previous.length), previous, "requests share an identical prefix");
  previous = messages;
  assistant([{ type: "text", text: `Working ${turn}` }]);
  user(`Continue ${turn}`);
}

await fire("session_start", { reason: "reload" });
await fire("session_start", { reason: "resume" });
assert.equal(anchors().length, 0, "restoring a visible plan adds no anchor");

manager.appendCompaction("Summary keeping the plan result", firstKept, 1000);
await fire("session_compact", { reason: "manual", fromExtension: false, willRetry: false });
assert.equal(anchors().length, 0, "a compaction that keeps the latest update_plan result adds no anchor");

user("More work");
const kept = manager.getLeafId()!;
manager.appendCompaction("Summary hiding the plan result", kept, 1000);
await fire("session_compact", { reason: "threshold", fromExtension: false, willRetry: false });
assert.equal(anchors().length, 1, "compaction hiding the plan adds exactly one anchor");
assert.match(anchors()[0].content, /- \[x\] Inspect\n- \[>\] Implement\n- \[ \] Verify/);
assert.equal(anchors()[0].display, false);
await fire("session_compact", { reason: "manual", fromExtension: false, willRetry: false });
await fire("session_start", { reason: "reload" });
assert.equal(anchors().length, 1, "an anchored plan is not re-sent");

const afterAnchor = await request();
user("Next prompt");
assert.deepEqual((await request()).slice(0, afterAnchor.length), afterAnchor, "the persisted anchor keeps the prefix stable");

await update("call-2", plan(2));
const beforeClear = manager.getLeafId()!;
await fire("session_compact", { reason: "manual", fromExtension: false, willRetry: false });
assert.equal(anchors().length, 1, "a newer visible update_plan result supersedes the anchor");

await commands.get("plan").handler("clear", ctx);
assert.equal(anchors().length, 2, "clearing a visible plan adds one cleared notice");
assert.match(anchors()[1].content, /Execution plan cleared/);
await fire("session_start", { reason: "reload" });
assert.equal(anchors().length, 2);

manager.branch(beforeClear);
await fire("session_tree", { newLeafId: beforeClear, oldLeafId: null });
assert.equal(anchors().length, 2, "navigating back to a visible plan adds no anchor");
manager.branch(firstKept);
await fire("session_tree", { newLeafId: firstKept, oldLeafId: null });
assert.equal(anchors().length, 2, "navigating before any plan adds no anchor");

console.log("plan anchors keep request prefixes stable and restate hidden plans once");
