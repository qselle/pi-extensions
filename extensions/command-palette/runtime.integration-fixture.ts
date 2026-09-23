import assert from "node:assert/strict";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { CommandPicker } from "./picker.ts";
import palette from "./index.ts";
import { commandCatalog } from "./catalog.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const keys = new KeybindingsManager(TUI_KEYBINDINGS);
const tui = { terminal: { rows: 32 }, requestRender() {} } as any;
const commands = Array.from({ length: 25 }, (_, index): SlashCommandInfo => ({ name: `command-${String(index).padStart(2, "0")}`, description: `界🌍 ${index} do useful work`, source: "extension",
  sourceInfo: { scope: "user", path: "/no-path-disclosure", source: "local", origin: "package" } }));
const catalog = commandCatalog(commands);
let result: string | null | undefined;
const seeded = new CommandPicker(catalog, "command-", theme, keys, tui, (value) => { result = value; });
seeded.handleInput("24"); seeded.handleInput("\r"); assert.equal(result, "command-24");
const picker = new CommandPicker(catalog, "", theme, keys, tui, (value) => { result = value; });
picker.focused = true;
assert(picker.focused);
for (const width of [0, 1, 2, 4, 12, 30, 60, 100]) {
  const lines = picker.render(width);
  assert(lines.every((line) => visibleWidth(line) <= width), `render overflow at ${width}`);
  assert(!lines.join("").includes("�"));
}
picker.handleInput("\x1b[B"); picker.handleInput("\r");
assert.equal(result, "command-01");
picker.handleInput("\x1b"); assert.equal(result, null);
picker.handleInput("24"); picker.handleInput("\r"); assert.equal(result, "command-24");
const empty = new CommandPicker(catalog, "nonexistent", theme, keys, tui, (value) => { result = value; });
result = undefined; empty.handleInput("\r"); assert.equal(result, undefined);
assert(empty.render(60).join("\n").includes("No matching commands"));
const tall = new CommandPicker(catalog, "", theme, keys, tui, () => {});
const initialRows = tall.render(80).length;
tui.terminal.rows = 14;
assert(tall.render(80).length < initialRows);

const events = new Map<string, Array<(...args: any[]) => any>>();
const registered = new Map<string, any>();
const shortcuts = new Map<string, any>();
const emitted: any[] = [];
const pi = { getCommands: () => commands, events: { emit: (name: string, event: any) => emitted.push({ name, event }) },
  on(name: string, callback: (...args: any[]) => any) { events.set(name, [...events.get(name) ?? [], callback]); },
  registerCommand: (name: string, spec: any) => registered.set(name, spec), registerShortcut: (name: string, spec: any) => shortcuts.set(name, spec) } as any;
palette(pi);
const notifications: string[] = [];
let draft = "unfinished question";
let complete: ((value: string | null) => void) | undefined;
let opens = 0;
const ctx = { mode: "tui", ui: { getEditorText: () => draft, setEditorText: (value: string) => { draft = value; },
  notify: (message: string) => notifications.push(message),
  custom(factory: any) { opens++; return new Promise<string | null>((resolve) => { complete = resolve; factory(tui, theme, keys, resolve); }); } } } as any;
const handler = registered.get("palette").handler;
let pending = shortcuts.get("ctrl+shift+p").handler(ctx);
assert.equal(opens, 1); complete!(null); await pending;
assert.equal(draft, "unfinished question");
pending = handler("work", ctx); complete!("command-03"); await pending;
assert.equal(draft, "/command-03 ");
await handler("restore", ctx); assert.equal(draft, "unfinished question");
await handler("restore", ctx); assert(notifications.at(-1)?.includes("No draft saved"));
pending = handler("", ctx); await handler("", ctx); assert.equal(opens, 3);
for (const reset of events.get("session_tree")!) reset();
await pending; assert.equal(draft, "unfinished question");
assert.equal(emitted.at(-1).event.open, false);
const oldOpenCount = opens;
await handler("", { ...ctx, mode: "rpc" }); assert.equal(opens, oldOpenCount);
pending = handler("", ctx); complete!("not-a-command"); await pending;
assert.equal(draft, "unfinished question");
// A late callback from another session cannot insert into the new session.
pending = handler("", ctx);
const staleComplete = complete;
for (const reset of events.get("session_start")!) reset();
staleComplete!("command-00"); await pending;
assert.equal(draft, "unfinished question");
console.log("command palette verified");
