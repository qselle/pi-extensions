import assert from "node:assert/strict";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import catBuddy from "./index.ts";
import { decorateCodexEditor } from "../codex-prompt/editor.ts";
const identity = (text: string) => text;
const theme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
const keys = { matches: () => false, getKeys: () => [] } as any;
const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as any;
for (const promptFirst of [true, false]) {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  let factory: any = () => {
    const editor = new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
    return promptFirst ? decorateCodexEditor(editor) : editor;
  };
  const ctx = { mode: "tui", ui: { getEditorComponent: () => factory, setEditorComponent: (value: any) => { factory = value; }, notify() {} } };
  catBuddy({ on: (name: string, callback: Function) => handlers.set(name, callback), registerCommand: (name: string, value: any) => commands.set(name, value), registerShortcut() {} } as any);
  handlers.get("session_start")!({}, ctx);
  await commands.get("cat").handler("static", ctx);
  const editor = promptFirst ? factory(tui, theme, keys) : decorateCodexEditor(factory(tui, theme, keys));
  const baseline = new CustomEditor(tui, theme, keys);
  for (const input of ["hello", "\x1b[D", "界", "\x1b[200~first\nsecond\x1b[201~", "\x7f"]) {
    editor.handleInput(input); baseline.handleInput(input);
    assert.equal(editor.getText(), baseline.getText());
    assert.deepEqual(editor.getCursor(), baseline.getCursor());
  }
  editor.setWorkingStatusIndicator({ renderInBorder: () => "Working on a long operation", renderSpinnerInBorder: () => "·" });
  for (const width of [34, 40, 80]) {
    const lines = editor.render(width);
    assert(lines.every((line: string) => visibleWidth(line) <= width));
    const bare = lines.map(stripVTControlCharacters).join("\n");
    assert(bare.includes("› "));
    assert(bare.includes("Working on a long operation"));
    assert(/[\u2800-\u28ff]/u.test(bare));
  }
  handlers.get("session_shutdown")!({}, ctx);
}
console.log("native companion composition verified in both decorator orders");
