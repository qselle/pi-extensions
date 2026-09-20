import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { initTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = await mkdtemp(join(tmpdir(), "pi-command-colors-"));
process.env.PI_CODING_AGENT_DIR = root;
const foreground = (color: string) => color === "text" ? "\x1b[38;5;252m" : "\x1b[38;5;245m";
const theme = {
  fg: (color: string, text: string) => `${foreground(color)}${text}\x1b[39m`,
  getFgAnsi: foreground,
  bold: (text: string) => text,
} as Theme;
try {
  const { default: register } = await import("./index.ts");
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Function>();
  register({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {},
    on: (event: string, handler: Function) => handlers.set(event, handler) } as never);
  handlers.get("session_start")!({}, { cwd: root });
  const bash = tools.get("bash")!;
  const render = (command: string, width = 160, expanded = false, running = false) => {
    const args = { command };
    const component = bash.renderCall!(args, theme, { args, expanded, executionStarted: running, isPartial: running } as never);
    const rows = component.render(width);
    assert.equal(args.command, command, "display must not rewrite tool arguments");
    assert(rows.every(row => visibleWidth(row) <= width), `width ${width} overflow`);
    return rows;
  };
  const colors = (rows: string[]) => new Set(rows.join("\n").match(/\x1b\[38;[^m]+m/g));
  initTheme("dark", false);
  const short = 'if true; then printf "%s\\n" "$PWD"; fi';
  for (const running of [false, true]) {
    const rows = render(short, 160, false, running);
    assert.equal(plain(rows.join("\n")), `• ${running ? "Running" : "Ran"} ${short}`);
    assert(colors(rows).size >= 4, "keywords, strings, variables and plain text need distinct colors");
    assert(rows[0]!.endsWith("\x1b[39m"), "close command foreground before tool output");
  }
  const multiline = 'if command -v git >/dev/null 2>&1; then\n  printf "%s\\n" "$PWD" # current directory\nfi';
  for (const width of [0, 1, 2, 4, 8, 24, 60, 100]) {
    for (const expanded of [false, true]) render(multiline, width, expanded, true);
  }
  const wide = render(multiline, 100, true);
  assert.equal(plain(wide[0]!), "• Ran command");
  assert.deepEqual(wide.slice(1).map(line => plain(line).slice(4)), multiline.split("\n"));
  assert(colors(wide).size >= 4);
  const narrow = render(multiline, 24, true);
  assert(narrow.length > wide.length);
  assert(colors(narrow).size >= 4, "wrapping must preserve colors");

  const many = Array.from({ length: 12 }, (_, index) => `printf 'line ${index}'`).join("\n");
  assert.equal(render(many, 80).length, 6, "collapsed commands show four rows and an expansion hint");
  assert(plain(render(many, 80, true).join("\n")).includes("line 11"));
  const unicode = 'printf "界🌍é" "$HOME"';
  for (const width of [1, 5, 12, 24, 80]) render(unicode, width, true);
  assert.equal(plain(render(unicode).join("\n")), `• Ran ${unicode}`);
  const injected = 'printf "ok"\x1b]52;c;untrusted\x07\x1b[31m';
  assert.equal(plain(render(injected).join("\n")), '• Ran printf "ok"');
  assert(!render(injected).join("\n").includes("]52"));
  const enormous = 'printf "' + "x".repeat(16_000) + '"';
  assert(colors(render(enormous, 80)).size <= 3, "oversized commands bypass the parser");
  assert(render(enormous, 80).length <= 6);

  const dark = render(short).join("\n");
  initTheme("light", false);
  const light = render(short).join("\n");
  assert.notEqual(dark, light, "theme changes must recolor commands");
  assert.equal(plain(dark), plain(light));
  console.log("Shell command colors, wrapping, theme changes and source preservation verified");
} finally { await rm(root, { recursive: true, force: true }); }
