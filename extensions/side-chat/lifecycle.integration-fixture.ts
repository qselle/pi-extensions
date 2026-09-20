import assert from "node:assert/strict";
import register from "./index.ts";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
const handlers = new Map<string, Function>();
const entries: any[] = [];
const pi = { on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }), events: { emit() {} } };
let authResolve: ((value: any) => void) | undefined;
let delayAuth = false;
let completions = 0;
const model = { provider: "test", id: "test", api: "test" };
const ctx = { hasUI: false, model, modelRegistry: { find: () => model, streamSimple: (_model: any, _context: any, options: any) => {
  const stream = new AssistantMessageEventStream();
  void (async () => {
    if (delayAuth) await new Promise((resolve) => { authResolve = resolve; });
    if (options.signal.aborted) {
      stream.push({ type: "error", reason: "aborted", error: { ...model, role: "assistant", content: [], stopReason: "aborted" } as any });
    } else {
      completions++;
      stream.push({ type: "done", reason: "stop", message: { ...model, role: "assistant", content: [{ type: "text", text: "Answer" }], stopReason: "stop" } as any });
    }
    stream.end();
  })();
  return stream;
} }, sessionManager: { getBranch: () => entries, getSessionId: () => "test" }, ui: { setStatus() {} } };
const titles: Array<{ signal: AbortSignal; resolve: (value: any) => void }> = [];
const store = register(pi as any, {
  registerCard: (() => ({ invalidate() {}, unregister() {} })) as any,
  titleConfig: { enabled: true },
  requestTitle: (async (options: any) => new Promise((resolve) => titles.push({ signal: options.signal, resolve }))) as any,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
handlers.get("session_start")!({}, ctx);
const chat = store.create({ model, systemPrompt: "", contextMode: "none", title: "Original" });
store.send(chat.id, "Question");
await flush();
assert.equal(titles.length, 1);
handlers.get("session_tree")!({}, ctx);
assert(titles[0]!.signal.aborted);
const count = entries.length;
titles[0]!.resolve({ title: "Stale title" });
await flush();
assert.equal(entries.length, count);
assert.equal(store.get(chat.id)!.title, "Original");
store.send(chat.id, "Another question");
await flush();
assert.equal(titles.length, 2);
store.rename(chat.id, "Manual title");
titles[1]!.resolve({ title: "Generated title" });
await flush();
assert.equal(store.get(chat.id)!.title, "Manual title");
delayAuth = true;
const before = completions;
store.send(chat.id, "Cancelled while authenticating");
store.abort(chat.id);
authResolve!({ ok: true });
await flush();
assert.equal(completions, before);
assert.equal(store.get(chat.id)!.status, "idle");
handlers.get("session_shutdown")!({}, ctx);
delayAuth = false;
let stream: AssistantMessageEventStream | undefined;
const streaming = register(pi as any, {
  registerCard: (() => ({ invalidate() {}, unregister() {} })) as any,
  titleConfig: { enabled: false },
  stream: (() => { stream = new AssistantMessageEventStream(); return stream; }) as any,
});
handlers.get("session_start")!({}, ctx);
const live = streaming.create({ model, systemPrompt: "", contextMode: "none" });
streaming.send(live.id, "Show text as it arrives");
await flush();
const partial: any = { role: "assistant", ...model, stopReason: "stop", timestamp: Date.now(), content: [{ type: "text", text: "First words" }] };
stream!.push({ type: "text_delta", contentIndex: 0, delta: "First words", partial });
await flush();
assert.equal(live.partial, "First words");
assert.equal(live.turns.length, 0);
assert(!JSON.stringify(entries).includes("First words"), "streaming chunks must not be persisted");
stream!.push({ type: "done", reason: "stop", message: { ...partial, content: [{ type: "text", text: "Final answer" }] } });
stream!.end();
await flush();
assert.equal(live.partial, undefined);
assert.equal(live.turns.at(-1)?.text, "Final answer");
handlers.get("session_shutdown")!({}, ctx);
console.log("side-chat title and authentication lifecycle verified");
