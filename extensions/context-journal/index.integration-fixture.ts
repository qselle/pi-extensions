import assert from "node:assert/strict";
import extension from "./index.ts";
import { JOURNAL_CONTEXT } from "./state.ts";
const tools = new Map<string, any>(); const commands = new Map<string, any>(); const handlers = new Map<string, Function>();
const entries: any[] = []; let active = ["bash", "context_notes", "context_history", "context_budget"];
const anchors: any[] = [];
extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, value: any) => commands.set(name, value),
  on: (name: string, handler: Function) => { const previous = handlers.get(name); handlers.set(name, (event: any, ctx: any) => { const prior = previous?.(event, ctx); return handler(prior ? { ...event, ...prior } : event, ctx) ?? prior; }); }, getActiveTools: () => active, setActiveTools: (next: string[]) => { active = next; },
  sendMessage: (message: any) => { anchors.push(message); entries.push({ type: "custom_message", ...message }); },
  appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }) } as never);
const projection = () => entries.flatMap((entry) => entry.type === "message" ? [entry.message] : entry.type === "custom_message" ? [{ role: "custom", ...entry }] : []);
const ctx = { ui: { notify() {} }, sessionManager: { getBranch: () => entries, buildSessionProjection: () => ({ messages: projection() }) }, getContextUsage: () => undefined };
handlers.get("session_start")!({}, ctx);
assert.deepEqual(active, ["bash"]);
await assert.rejects(tools.get("context_notes").execute("x", { action: "list" }), /disabled/);
await commands.get("context-journal").handler("on", ctx);
assert(active.includes("context_history"));
await tools.get("context_notes").execute("x", { action: "write", key: "objective", text: "Complete the whole task" });
// Requests are never extended with notes, so the cached prefix stays stable.
const user = { role: "user", content: "hello" };
assert.equal(handlers.get("context")!({ messages: [user] }, ctx), undefined);
assert.equal(anchors.length, 0);
await commands.get("context-journal").handler("off", ctx);
assert.deepEqual(active, ["bash"]);
const anchor = { role: "custom", customType: JOURNAL_CONTEXT, content: "notes", display: false };
assert.deepEqual(handlers.get("context")!({ messages: [user, anchor] }, ctx).messages, [user]);
handlers.get("session_tree")!({}, { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => entries.slice(0, 2) } });
assert(active.includes("context_notes"));
assert.equal(anchors.length, 1, "restore persists one hidden note anchor");
assert.equal(anchors[0].display, false);
assert(anchors[0].content.includes("Complete the whole task"));
handlers.get("session_tree")!({}, { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => entries.slice(0, 2) } });
assert.equal(anchors.length, 1, "a visible anchor is not repeated");
const read = await tools.get("context_notes").execute("x", { action: "read", key: "objective" });
assert.equal(read.content[0].text, "Complete the whole task");
assert((await tools.get("context_budget").execute("x", {}, undefined, undefined, ctx)).content[0].text.includes("unknown"));
entries.push({ type: "message", id: "old", message: { role: "user", content: "older task" } }, { type: "message", id: "new", message: { role: "user", content: "newer task" } });
const first = await tools.get("context_history").execute("x", { limit: 1 }, undefined, undefined, ctx);
assert(first.content[0].text.includes('before="new"'));
const last = await tools.get("context_history").execute("x", { limit: 1, before: "new" }, undefined, undefined, ctx);
assert(last.content[0].text.includes("End of matching history"));
assert.equal(last.details.nextBefore, undefined);
console.log("journal activation, restoration, injection and budget checks verified");
