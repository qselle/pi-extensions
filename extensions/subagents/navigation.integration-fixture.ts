import assert from "node:assert/strict";
import register from "./index.ts";
const handlers = new Map<string, any>();
let command: any;
const coordinator = register({ on: (name: string, fn: any) => handlers.set(name, fn), registerCommand: (_name: string, value: any) => { command = value; }, registerTool() {}, registerMessageRenderer() {}, events: { emit() {} } } as any, {
  registerCard: (() => ({ invalidate() {}, unregister() {} })) as any,
})!;
coordinator.list = () => [{ name: "Child", task: "Review", status: "completed", contextMode: "fresh", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] as any;
coordinator.transcript = () => ({ agent: coordinator.list()[0]!, entries: [] });
let release!: (value: string) => void;
let label = "";
let opened = 0;
const ctx = { mode: "tui", hasUI: false, sessionManager: { getBranch: () => [] }, ui: {
  select: (_title: string, labels: string[]) => { label = labels[0]!; return new Promise<string>((resolve) => { release = resolve; }); },
  custom: async () => { opened++; }, notify() {}, setStatus() {},
} };
assert.deepEqual(command.getArgumentCompletions("chi"), [{ value: "Child", label: "Child" }]);
await command.handler("child", ctx);
assert.equal(opened, 1, "a supplied name opens directly without a picker");
await command.handler("missing", ctx);
assert.equal(opened, 1, "an unknown name does not open another child");
opened = 0;
for (const event of ["session_tree", "session_start", "session_shutdown"]) {
  const pending = command.handler("", ctx);
  await handlers.get(event)({}, ctx);
  release(label);
  await pending;
  assert.equal(opened, 0, `${event} must invalidate the old selection`);
}
await handlers.get("session_start")({}, ctx);
let closed = 0;
let ready!: () => void;
const openedView = new Promise<void>((resolve) => { ready = resolve; });
(ctx.ui as any).custom = (factory: any) => new Promise<void>((resolve) => {
  factory({ requestRender() {} }, {}, {}, () => { closed++; resolve(); });
  ready();
});
const viewing = command.handler("", ctx);
release(label);
await openedView;
await handlers.get("session_tree")({}, ctx);
await viewing;
assert.equal(closed, 1, "navigation must close an already-open transcript");
await handlers.get("session_shutdown")({}, ctx);
console.log("subagent selections cannot cross session lifecycle boundaries");
