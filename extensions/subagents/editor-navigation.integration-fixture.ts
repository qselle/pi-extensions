import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomEditor, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import register from "./index.ts";
import cat from "../cat-buddy/index.ts";
import prompt from "../codex-prompt/index.ts";
import { ChildTranscriptBrowser } from "./transcript.ts";
import type { AgentSnapshot } from "./coordinator.ts";
import type { EditorFactory } from "./editor-navigation.ts";

const root = await mkdtemp(join(tmpdir(), "pi-child-keys-"));
process.env.PI_CODING_AGENT_DIR = root; process.env.PI_SUBAGENT_CHILD = "0";
const identity = (value: string) => value;
const theme: any = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value,
  bold: identity, italic: identity, strikethrough: identity };
const editorTheme: any = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
const keys = new KeybindingsManager(TUI_KEYBINDINGS) as any;
const tui: any = { terminal: { rows: 24, columns: 80, showCursor() {} }, requestRender() {} };
const makeAgent = (name: string, startedAt: number, status: AgentSnapshot["status"] = "completed"): AgentSnapshot => ({
  id: name, name, task: `${name} task`, status, createdAt: startedAt, startedAt, cwd: root, contextMode: "fresh", output: "", activity: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
try {
  initTheme("dark", false);
  for (const order of [["child", "cat", "prompt"], ["child", "prompt", "cat"], ["cat", "child", "prompt"], ["cat", "prompt", "child"], ["prompt", "child", "cat"], ["prompt", "cat", "child"]]) {
    const events = new Map<string, Function[]>(), commands = new Map<string, any>();
    let factory: EditorFactory | undefined, editor: any, modal: any, opened = 0;
    let agents = [makeAgent("first", 1), makeAgent("second", 2)];
    const pi: any = { on: (name: string, handler: Function) => { events.set(name, [...(events.get(name) ?? []), handler]); return () => {}; },
      registerCommand: (name: string, command: any) => commands.set(name, command), registerTool() {}, registerMessageRenderer() {}, registerShortcut() {},
      appendEntry() {}, events: { emit() {}, on: () => () => {} } };
    const baselineFactory: EditorFactory = (tui, theme, keys) => new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
    factory = baselineFactory; editor = factory(tui, editorTheme, keys);
    const ctx: any = { mode: "tui", hasUI: true, cwd: root, sessionManager: { getBranch: () => [] }, ui: {
      theme, getEditorComponent: () => factory,
      setEditorComponent: (next: EditorFactory) => { const draft = editor.getText(); factory = next; editor = (next ?? baselineFactory)(tui, editorTheme, keys); editor.setText(draft); },
      getEditorText: () => editor.getText(), notify() {}, setStatus() {},
      custom: (build: Function) => new Promise<void>((resolve) => {
        opened++;
        modal = build(tui, theme, keys, () => { modal = undefined; resolve(); });
        modal.focused = true;
      }),
    } };
    const emit = async (name: string) => { for (const handler of events.get(name) ?? []) await handler({}, ctx); };
    for (const name of order) {
      if (name === "cat") cat(pi);
      else if (name === "prompt") prompt(pi);
      else {
        const coordinator = register(pi, { registerCard: (() => ({ invalidate() {}, unregister() {} })) as any })!;
        coordinator.list = () => agents;
        coordinator.transcript = (name) => ({ agent: agents.find((agent) => agent.name === name)!, entries: [] });
      }
    }
    await emit("session_start");
    const baseline = baselineFactory(tui, editorTheme, keys) as CustomEditor;
    let expandedReads = 0;
    const expandedText = editor.getExpandedText.bind(editor);
    editor.getExpandedText = () => { expandedReads++; return expandedText(); };
    for (const input of ["hello", "\x1b[D", "界", "\x1b[C", "\x1b[200~first\nsecond\x1b[201~", "\x1b[1;5C"]) {
      const before = expandedReads;
      editor.handleInput(input); baseline.handleInput(input);
      if (input !== "\x1b[C") assert.equal(expandedReads, before, "ordinary input must not expand pasted drafts");
      assert.equal(editor.getText(), baseline.getText(), `${order}: preserves ordinary editor input`);
      assert.deepEqual(editor.getCursor(), baseline.getCursor());
    }
    await tick(); assert.equal(opened, 0);
    editor.setText(" "); editor.handleInput("\x1b[C"); await tick(); assert.equal(opened, 0, "whitespace remains a draft");
    editor.setText(""); editor.handleInput("\x1b[C"); await tick();
    assert.equal(opened, 1, `${order}: Right opens exactly one viewer`);
    assert(modal.render(80).join("\n").includes("Subagent · first"));
    modal.handleInput("\x1b[C"); assert(modal.render(80).join("\n").includes("Subagent · second"));
    modal.handleInput("\x1b[D"); modal.handleInput("\x1b[D"); await tick(); assert.equal(modal, undefined);
    assert.equal(editor.getText(), "");
    // Re-arming through later editor decorators must not multiply listeners.
    await emit("session_start"); await emit("session_start");
    editor.setText(""); editor.handleInput("\x1b[C"); editor.handleInput("fresh draft"); await tick();
    assert.equal(opened, 1, "fresh typing cancels deferred opening");
    editor.setText(""); editor.handleInput("\x1b[C"); await emit("session_tree"); await tick();
    assert.equal(opened, 1, "session navigation cancels deferred opening");
    editor.handleInput("\x1b[C"); await tick(); assert.equal(opened, 2);
    await emit("session_shutdown"); await tick(); assert.equal(modal, undefined);
    editor.handleInput("\x1b[C"); await tick(); assert.equal(opened, 2, "stale decorators are inert after shutdown");
    agents = [];
  }

  const agents = [makeAgent("first", 1), makeAgent("closed", 2, "closed"), makeAgent("second", 3), makeAgent("third", 4)];
  const body = Array.from({ length: 50 }, (_, index) => `line ${index} needle`).join("\n");
  let closed = 0;
  const browser = new ChildTranscriptBrowser("first", () => agents, (name) => ({ agent: agents.find((agent) => agent.name === name)!,
    entries: [{ type: "message", id: name, message: { role: "assistant", content: [{ type: "text", text: body }] } }] }), theme, keys, tui, () => { closed++; });
  browser.focused = true;
  browser.handleInput("\x1b[C"); assert(browser.render(70).join("\n").includes("Subagent · second"));
  browser.handleInput("/"); browser.handleInput("needle"); browser.render(70);
  browser.handleInput("\x1b[D"); assert(browser.render(70).join("\n").includes("Subagent · second"), "Left edits the search input");
  browser.handleInput("\x1b[C"); browser.handleInput("\r");
  const searched = browser.render(70).join("\n"); assert(searched.includes("matches"));
  browser.handleInput("\x1b[C"); assert(browser.render(70).join("\n").includes("Subagent · third"));
  browser.handleInput("\x1b[D"); assert.equal(browser.render(70).join("\n"), searched, "switching retains this child's search and viewport");
  for (const width of [1, 20, 45, 80]) assert(browser.render(width).every((line) => visibleWidth(line) <= width));
  // A follow-up changes the current run's timestamp, never sibling navigation.
  agents[0]!.startedAt = 100; agents[0]!.status = "running";
  browser.refresh();
  assert(browser.render(100)[0]!.includes("Subagent · second · completed · 2/3"));
  browser.handleInput("\x1b[D");
  assert.equal(closed, 0, "Left must still reach the first child after its follow-up");
  assert(browser.render(100)[0]!.includes("Subagent · first · running · 1/3"));
  browser.handleInput("\x1b[D"); assert.equal(closed, 1);
  console.log("native child navigation, editor composition, drafts, search, lifecycle and widths verified");
} finally { await rm(root, { recursive: true, force: true }); }
