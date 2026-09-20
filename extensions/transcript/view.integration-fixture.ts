import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TranscriptView } from "../../lib/transcript/view.ts";
import { transcriptBlocks, plainText } from "../../lib/transcript/model.ts";
import extension from "./index.ts";

initTheme("dark", false);
const theme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (text: string) => text } as any;
const keys = {
  matches: (data: string, key: string) => data === ({ "tui.select.up": "up", "tui.select.down": "down", "tui.select.pageUp": "pageUp", "tui.select.pageDown": "pageDown", "tui.select.confirm": "enter", "tui.select.cancel": "escape" } as Record<string, string>)[key],
  getKeys: () => [],
} as any;
const tui = { terminal: { rows: 20 }, requestRender() {} } as any;
const entries: any[] = [{ id: "first", type: "message", message: { role: "assistant", content: [
  { type: "thinking", thinking: "private reasoning" },
  { type: "text", text: "# Heading\n\n```ts\nconst value = 1;\n```" },
] } }, ...Array.from({ length: 40 }, (_, i) => ({ id: `row-${i}`, type: "message", message: { role: "user", content: `Prompt ${i} · 界` } }))];
let loads = 0;
let closes = 0;
const view = new TranscriptView(() => { loads++; return transcriptBlocks(entries); }, "current branch", theme, keys, tui, () => closes++);
const render = (width = 80) => view.render(width).map(plainText).join("\n");
assert(render().includes("Prompt 39"));
assert(view.render(80).every((line) => visibleWidth(line) === 80), "modal rows must fill their frame");
assert(plainText(view.render(80)[0]).startsWith("╭"));
assert(plainText(view.render(80).at(-1)).endsWith("╯"));
const narrowHelp = plainText(view.render(40).at(-1));
assert(narrowHelp.includes("q/Esc close") && narrowHelp.includes("/ search") && narrowHelp.includes("↑↓ scroll"));
assert(plainText(view.render(20).at(-1)).includes("q/Esc close"));
assert(plainText(view.render(100).at(-1)).includes("End follow"));
view.handleInput("\x1b[H"); // Home, real Pi key parser
assert(render().includes("Heading"));
assert(!render().includes("private reasoning"));
view.handleInput("t");
assert(render().includes("private reasoning"));
const loadsBeforeScroll = loads;
view.handleInput("down");
render();
assert.equal(loads, loadsBeforeScroll, "scroll must not reload session entries");
view.handleInput("/");
for (const char of "Prompt 2") view.handleInput(char);
assert(render().includes("matches"));
assert(render().includes("Prompt 2"));
view.handleInput("enter");
view.handleInput("n");
assert(render().includes("Prompt 20"));
view.handleInput("N");
assert(render().includes("Prompt 2"));
view.handleInput("pageDown");
const beforeAppend = render();
entries.push({ id: "last", type: "message", message: { role: "user", content: "brand new message" } });
view.refresh();
assert.equal(render(), beforeAppend, "new output must not steal scroll position");
view.handleInput("\x1b[F"); // End
assert(render().includes("brand new message"));
for (const width of [1, 2, 10, 40, 80]) for (const height of [3, 10, 30]) {
  tui.terminal.rows = height;
  const output = view.render(width);
  assert(output.length <= Math.max(1, Math.floor(height * 0.9) - 2));
  assert(output.every((line) => visibleWidth(line) <= width));
}
assert.deepEqual(view.render(0), []);
view.close(); view.close();
assert.equal(closes, 1);

// Exercise the extension's actual hooks and panel lifecycle, including the
// host's message_end-before-persistence ordering.
const commands = new Map<string, any>();
const handlers = new Map<string, Function>();
const events: any[] = [];
let panel: TranscriptView;
let finished!: () => void;
extension({
  registerCommand: (name: string, value: unknown) => commands.set(name, value),
  registerShortcut() {},
  on: (name: string, fn: Function) => handlers.set(name, fn),
  events: { emit: (...args: any[]) => events.push(args) },
} as never);
tui.terminal.rows = 30;
const saved: any[] = [];
const context = { mode: "tui", sessionManager: { getBranch: () => saved, getEntries: () => saved }, ui: {
  notify() {}, custom: (factory: Function) => new Promise<void>((resolve) => { finished = resolve; panel = factory(tui, theme, keys, resolve); }),
} };
const opened = commands.get("transcript").handler("", context);
const message = { role: "assistant", content: [{ type: "text", text: "final result" }] };
handlers.get("message_end")!({ message });
assert(panel!.render(80).map(plainText).join("\n").includes("final result"));
saved.push({ type: "message", id: "saved", message });
handlers.get("agent_settled")!();
assert.equal(panel!.render(80).map(plainText).join("\n").split("final result").length - 1, 1);
handlers.get("message_update")!({ message });
handlers.get("session_shutdown")!();
await opened;
assert.deepEqual(panel!.render(80), []);
assert.equal(events.length, 1, "shutdown must not emit through the replaced extension");

// A single large tool result exceeds the argument-count limit of array spread.
// It must stay browsable without truncation or a full history reload per scroll.
let largeLoads = 0;
const large = new TranscriptView(() => {
  largeLoads++;
  return [{ id: "large", kind: "tool", label: "Tool result", body: "line\n".repeat(130000) + "last line" }];
}, "large output", theme, keys, tui, () => {});
assert(large.render(80).join("\n").includes("last line"));
for (let i = 0; i < 20; i++) { large.handleInput("up"); large.render(80); }
assert.equal(largeLoads, 1);
large.handleInput("/");
for (const char of "last line") large.handleInput(char);
assert(large.render(80)[0]!.includes("1/1 matches"));
assert.equal(largeLoads, 1, "search must reuse loaded history");
large.close();

// Match locations follow the native renderer's wraps, including hard-split words,
// Markdown inline styling, quotes, code and repeated matches on one physical row.
for (const markdown of [false, true]) {
  for (const body of markdown ? [
    "before **stable phrase across wraps** after",
    "> before stable phrase across wraps after",
    "- before stable phrase across wraps after",
    "```text\nbefore stable phrase across wraps after\n```",
  ] : ["before stable phrase across wraps after"]) {
    const highlighted: string[] = [];
    const matchTheme = { ...theme, bg: (_color: string, line: string) => { highlighted.push(plainText(line)); return line; } };
    const search = new TranscriptView(() => [{ id: "search", kind: "assistant", label: "Assistant", body, markdown }],
      "search", matchTheme, keys, tui, () => {}, "stable phrase across wraps");
    for (const width of [80, 24, 16, 8, 40]) {
      highlighted.length = 0;
      const output = search.render(width).map(plainText);
      if (width >= 40) assert(output[0]!.includes("1/1 matches"), output[0]);
      assert(highlighted.length > 0, `no match for ${JSON.stringify(body)} at ${width}`);
      if (width === 16) assert(highlighted.length >= 2, `wrapped match must highlight multiple rows: ${body}`);
    }
    search.close();
  }
}
const repeated = new TranscriptView(() => [{ id: "repeat", kind: "user", label: "You", body: "same phrase / same phrase" }],
  "repeat", theme, keys, tui, () => {}, "same phrase");
assert(repeated.render(80)[0]!.includes("1/2 matches"));
repeated.handleInput("n");
assert(repeated.render(80)[0]!.includes("2/2 matches"));
repeated.render(8);
assert(repeated.render(80)[0]!.includes("2/2 matches"), "resize must retain selected occurrence");
repeated.handleInput("N");
assert(repeated.render(80)[0]!.includes("1/2 matches"));
repeated.close();
console.log("transcript rendering, search, scrolling and lifecycle verified");
