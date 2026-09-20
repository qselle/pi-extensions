import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
initTheme("dark", false);
for (const boundary of ["session_start", "session_tree", "session_shutdown"]) {
  const handlers = new Map<string, any>(); let command: any;
  const events: any[] = []; const edits: string[] = []; const inputs: string[] = [];
  let baseCalls = 0; let closes = 0;
  let factory: any = () => { baseCalls++; return { handleInput: (data: string) => inputs.push(data) }; };
  const original = factory;
  const pending: Array<(value: string | null) => void> = [];
  const ctx = { mode: "tui", sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "prior prompt" } }] },
    ui: { notify() {}, getEditorText: () => "draft", setEditorText: (text: string) => edits.push(text),
      getEditorComponent: () => factory, setEditorComponent: (value: any) => { factory = value; },
      custom: async (create: Function) => {
        create({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, { matches: () => false, getKeys: () => [] }, () => closes++);
        // Deliberately deliver a selection even after close, to verify stale guards.
        return new Promise<string | null>((resolve) => pending.push(resolve));
      },
    },
  };
  extension({ on: (name: string, fn: any) => handlers.set(name, fn), registerCommand: (_: string, value: any) => { command = value; }, events: { emit: (_: string, value: unknown) => events.push(value) } } as any);
  handlers.get("session_start")({ reason: "new" }, ctx);
  const installed = factory;
  // Another editor decorator may wrap this factory before the next start.
  factory = (...args: any[]) => installed(...args);
  const decorated = factory;
  handlers.get("session_start")({ reason: "resume" }, ctx);
  assert.equal(factory, decorated);
  const editor = factory({}, {}, {});
  editor.handleInput("hello");
  assert.equal(baseCalls, 1);
  assert.deepEqual(inputs, ["hello"]);
  const old = command.handler("", ctx);
  assert.equal(pending.length, 1);
  handlers.get(boundary)({ reason: "resume" }, ctx);
  assert.equal(closes, 1);
  if (boundary !== "session_shutdown") {
    const fresh = command.handler("", ctx);
    const eventCount = events.length;
    pending[0]!("stale prompt"); await old;
    assert.equal(events.length, eventCount, "old cleanup must not close the new modal");
    assert.deepEqual(edits, []);
    pending[1]!("fresh prompt"); await fresh;
    assert.deepEqual(edits, ["fresh prompt"]);
    handlers.get("session_shutdown")({}, ctx);
  } else {
    pending[0]!("stale prompt"); await old;
    assert.deepEqual(edits, []);
    editor.handleInput("\x12");
    assert.equal(pending.length, 1, "old editor cannot open a picker after shutdown");
  }
  assert.equal(factory, decorated, "shutdown preserves another decorator's ownership");
  assert.notEqual(factory, original);
}
console.log("history picker lifecycle and editor composition verified");
