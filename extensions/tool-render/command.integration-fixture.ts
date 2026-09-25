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
  getBgAnsi: () => "\x1b[48;2;60;56;54m",
  bold: (text: string) => text,
} as unknown as Theme;
try {
  const { default: register } = await import("./index.ts");
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Function>();
  register({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {},
    on: (event: string, handler: Function) => handlers.set(event, handler) } as never);
  handlers.get("session_start")!({}, { cwd: root });
  const bash = tools.get("bash")!;
  const render = (command: string, width = 160, expanded = false, running = false, purpose?: unknown) => {
    const args = { command, purpose };
    const component = bash.renderCall!(args, theme, { args, expanded, executionStarted: running, isPartial: running } as never);
    const rows = component.render(width);
    assert.equal(args.command, command, "display must not rewrite tool arguments");
    assert.equal(args.purpose, purpose, "display must not rewrite saved purpose metadata");
    assert(rows.every(row => visibleWidth(row) <= width), `width ${width} overflow`);
    return rows;
  };
  const colors = (rows: string[]) => new Set(rows.join("\n").match(/\x1b\[38;[^m]+m/g));
  const displayed = (rows: string[]) => rows.map((line) => plain(line).trimEnd());
  initTheme("dark", false);
  const short = 'if true; then printf "%s\\n" "$PWD"; fi';
  assert.equal((bash.parameters as any).properties.purpose.type, "string");
  assert(!(bash.parameters as any).required.includes("purpose"), "old calls must remain executable without purpose metadata");
  assert(bash.promptGuidelines?.some(line => line.includes("purpose")), "the model needs guidance to supply a useful caption");
  for (const running of [false, true]) {
    const rows = render(short, 160, false, running);
    assert.deepEqual(displayed(rows), [`• ${running ? "Running" : "Ran"} command`, `  │ ${short}`]);
    assert(colors(rows).size >= 4, "keywords, strings, variables and plain text need distinct colors");
    assert(rows[1]!.endsWith("\x1b[0m"), "close command styles and background before tool output");
    assert(rows[1]!.includes(theme.getBgAnsi("toolPendingBg")), "commands use a neutral inset surface");
  }
  const purpose = "Check shell quoting and paths";
  for (const running of [false, true]) {
    const rows = render(short, 160, false, running, purpose);
    assert.deepEqual(displayed(rows), [`• ${running ? "Running" : "Ran"} command · ${purpose}`, `  │ ${short}`]);
    assert(!rows[0]!.includes(theme.getBgAnsi("toolPendingBg")), "the purpose belongs outside the source panel");
    assert(rows[0]!.includes(theme.fg("text", purpose)), "the purpose uses readable neutral text");
  }
  for (const empty of [undefined, null, 0, {}, "", " \n\t ", "\x1b[31m"]) {
    assert.equal(displayed(render(short, 160, false, false, empty))[0], "• Ran command");
  }
  const noisyPurpose = "Check\n API\t\x1b[31mbehavior\x1b[0m\x1b]52;c;untrusted\x07";
  const sanitized = render(short, 160, false, false, noisyPurpose);
  assert.equal(plain(sanitized[0]!), "• Ran command · Check API behavior");
  assert(!sanitized[0]!.includes("untrusted"));
  for (let width = 0; width <= 180; width++) {
    const rows = render(short, width, false, false, "Check 界🌍 é Unicode output ".repeat(20));
    assert(rows.length === render(short, width).length, "captions must not add extra rows or displace the source preview");
  }
  const preparedArgs = { purpose, command: short };
  const prepared = bash.renderCall!(preparedArgs, theme, { args: preparedArgs, isPartial: true, executionStarted: false } as never).render(160);
  assert.equal(plain(prepared[0]!), `• Command · ${purpose}`, "a streamed purpose must not claim execution started");
  const failed = bash.renderCall!(preparedArgs, theme, { args: preparedArgs, isError: true } as never).render(160);
  assert.equal(plain(failed[0]!), `• Command failed · ${purpose}`);
  const safeArgs = { command: short, purpose: "[redacted]" };
  const safe = bash.renderCall!(safeArgs, theme, { args: { ...safeArgs, purpose: "RAW_SECRET" } } as never).render(160);
  assert(!plain(safe.join("\n")).includes("RAW_SECRET"), "the sanitized renderer arguments take precedence over raw context");
  const multiline = 'if command -v git >/dev/null 2>&1; then\n  printf "%s\\n" "$PWD" # current directory\nfi';
  for (let width = 0; width <= 200; width++) {
    for (const expanded of [false, true]) render(multiline, width, expanded, true);
  }
  const wide = render(multiline, 100, true);
  assert.equal(plain(wide[0]!), "• Ran command");
  assert.deepEqual(displayed(wide).slice(1).map(line => line.slice(4)), multiline.split("\n"));
  assert(colors(wide).size >= 4);
  const narrow = render(multiline, 24, true);
  assert(narrow.length > wide.length);
  assert(colors(narrow).size >= 4, "wrapping must preserve colors");

  const many = Array.from({ length: 12 }, (_, index) => `printf 'line ${index}'`).join("\n");
  assert.equal(render(many, 80).length, 6, "collapsed commands show four rows and an expansion hint");
  assert(plain(render(many, 80, true).join("\n")).includes("line 11"));
  const unicode = 'printf "界🌍é" "$HOME"';
  for (const width of [1, 5, 12, 24, 80]) render(unicode, width, true);
  assert.deepEqual(displayed(render(unicode)), ["• Ran command", `  │ ${unicode}`]);
  const tabbed = '\tprintf "a\tb"\n\t\tprintf end';
  const tabs = render(tabbed, 160, true);
  assert(!tabs.join("\n").includes("\t"));
  assert.deepEqual(displayed(tabs).slice(1).map(line => line.slice(4)), tabbed.replace(/\t/g, "    ").split("\n"));
  const injected = 'printf "ok"\x1b]52;c;untrusted\x07\x1b[31m';
  assert.deepEqual(displayed(render(injected)), ["• Ran command", '  │ printf "ok"']);
  assert(!render(injected).join("\n").includes("]52"));
  const enormous = 'printf "' + "x".repeat(16_000) + '"';
  assert(colors(render(enormous, 80)).size <= 3, "oversized commands bypass the parser");
  assert(render(enormous, 80).length <= 6);
  const token = 'printf ' + 'a'.repeat(220);
  const wrappedToken = displayed(render(token, 24, true)).slice(1).map(line => line.slice(4));
  assert.equal(wrappedToken.join("").replace(/ /g, ""), token.replace(/ /g, ""), "long tokens wrap without truncating characters");
  const huge = Array.from({ length: 150 }, (_, index) => `printf '${index}'`).join("\n");
  assert.equal(render(huge, 80, true).length, 130, "expanded commands stay bounded to128rows plus header and hint");
  assert(plain(render(huge, 80, true).join("\n")).includes("preview limit"));
  assert(!plain(render(huge, 80, true).join("\n")).includes("to expand"), "the maximum preview must not offer another expansion");

  const dark = render(short).join("\n");
  initTheme("light", false);
  const light = render(short).join("\n");
  assert.notEqual(dark, light, "theme changes must recolor commands");
  assert.equal(plain(dark), plain(light));
  console.log("Shell command colors, wrapping, theme changes and source preservation verified");
} finally { await rm(root, { recursive: true, force: true }); }
