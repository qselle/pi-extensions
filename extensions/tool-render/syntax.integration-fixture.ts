import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { getLanguageFromPath, highlightCode, initTheme, Theme, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setCapabilities, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { highlightSyntax } from "../../lib/syntax.ts";
import palette from "../../themes/gruvbox-dark.json";
import headless from "@xterm/headless";

const root = await mkdtemp(join(tmpdir(), "pi-tool-syntax-"));
process.env.PI_CODING_AGENT_DIR = root;
setCapabilities({ images: null, trueColor: true, hyperlinks: false });
initTheme("dark", false);
const resolved = Object.fromEntries(Object.entries(palette.colors).map(([key, value]) =>
  [key, value.startsWith("#") ? value : palette.vars[value as keyof typeof palette.vars]]));
const makeTheme = (name: string) => new Theme(resolved as ConstructorParameters<typeof Theme>[0], resolved as ConstructorParameters<typeof Theme>[1], "truecolor", { name });
const theme = makeTheme("gruvbox-dark");
try {
  const { default: register } = await import("./index.ts");
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Function>();
  let registrations = 0;
  register({ registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); registrations++; }, registerCommand() {},
    on: (name: string, handler: Function) => handlers.set(name, handler) } as never);
  // Noninteractive startup registers tools without loading the display service.
  await handlers.get("session_start")!({}, { cwd: root, mode: "json" });
  const bash = tools.get("bash")!;
  const renderCommand = (code: string, currentTheme: Theme = theme, width = 160) => {
    const args = { command: code };
    const rows = bash.renderCall!(args, currentTheme, { args, expanded: true } as never).render(width);
    assert.equal(args.command, code);
    assert(rows.every((line) => visibleWidth(line) <= width));
    return rows;
  };
  const command = 'if true; then printf "%s\\n" "$PWD"; fi';
  assert.equal(highlightSyntax(command, "bash"), undefined);
  const before = renderCommand(command).join("\n");
  assert.deepEqual(before.split("\n").map((line) => plain(line).trimEnd()), ["• Ran command", `  │ ${command}`]);
  const nativeCommand = (currentTheme: Theme) => currentTheme.fg("text", highlightCode(command, "bash").join("\n")
    .replace(/\x1b\[39m/g, currentTheme.getFgAnsi("text")));
  assert(before.includes(nativeCommand(theme)), "uninitialized service must retain native highlighting");

  const count = registrations;
  await handlers.get("session_start")!({}, { cwd: root, mode: "tui" });
  assert.equal(registrations, count, "syntax initialization must not duplicate tool registration");
  const after = renderCommand(command).join("\n");
  assert(after.includes(highlightSyntax(command, "bash")!.join("\n")), "Bash uses shared grammar colors once ready");
  assert.notEqual(after, before);
  assert.equal(plain(after), plain(before));
  assert(new Set(after.match(/\x1b\[38;2;[^m]+m/g)).size >= 4, "commands need distinct RGB syntax colors");

  const read = tools.get("read")!;
  const code = 'const greeting: string = "hello 界"; // greeting\n\nconsole.log(greeting);';
  const content = { content: [{ type: "text" as const, text: code }], details: undefined };
  const readContext = { args: { path: "src/sample.ts" }, cwd: root, isError: false };
  const readPreview = read.renderResult!(content, { expanded: true, isPartial: false }, theme, readContext as never);
  const readRows = readPreview.render(160);
  assert.deepEqual(readRows.slice(1).map((line) => plain(line).slice(4)), code.split("\n"));
  for (const line of highlightSyntax(code, "typescript")!) assert(readRows.some((row) => row.includes(line)));
  assert.equal(content.content[0]!.text, code, "source result stays untouched");
  const collapsed = read.renderResult!(content, { expanded: false, isPartial: false }, theme, readContext as never).render(160);
  assert.equal(collapsed.length, 1, "syntax does not expand a collapsed read");

  const edit = tools.get("edit")!;
  const editPreview = edit.renderResult!({ content: [], details: { patch: '@@ -1,2 +1,2 @@\n-const answer = 1;\n+const answer = 2;\n console.log(answer);' } },
    { expanded: true, isPartial: false }, theme, { args: { path: "src/sample.ts" }, cwd: root } as never);
  const edits = editPreview.render(160);
  assert(edits[1]!.includes(theme.getBgAnsi("toolErrorBg")));
  assert(edits[2]!.includes(theme.getBgAnsi("toolSuccessBg")));
  const diffCode = 'const answer = 1;\nconst answer = 2;\nconsole.log(answer);';
  for (const line of highlightSyntax(diffCode, "typescript")!) assert(edits.some((row) => row.includes(line)), "diff wash must preserve syntax colors");

  const write = tools.get("write")!;
  const writePreview = write.renderResult!({ content: [], details: undefined }, { expanded: true, isPartial: false }, theme,
    { args: { path: "src/new.ts", content: code }, cwd: root } as never);
  assert(writePreview.render(160).some((row) => row.includes(highlightSyntax(code, "typescript")![0]!)));
  for (const width of [0, 1, 2, 4, 8, 24, 60, 100]) {
    renderCommand(`${command}\nprintf '界🌍'`, theme, width);
    for (const component of [readPreview, editPreview, writePreview]) {
      assert(component.render(width).every((line) => visibleWidth(line) <= width), `width ${width} overflow`);
    }
  }

  const php = '<?php echo "hello";';
  const phpLanguage = getLanguageFromPath("sample.php")!;
  assert.equal(highlightSyntax(php, phpLanguage), undefined);
  const fallback = read.renderResult!({ content: [{ type: "text", text: php }], details: undefined }, { expanded: true, isPartial: false }, theme,
    { args: { path: "sample.php" }, cwd: root } as never).render(160).join("\n");
  assert(fallback.includes(highlightCode(php, phpLanguage)[0]!), "unsupported Shiki grammar retains native highlighting");

  initTheme("light", false);
  const otherTheme = makeTheme("another-theme");
  assert(renderCommand(command, otherTheme).join("\n").includes(nativeCommand(otherTheme)), "other themes use their native syntax colors");
  const longLine = `printf '${"x".repeat(4100)}'`;
  assert.equal(highlightSyntax(longLine, "bash"), undefined);
  assert(plain(renderCommand(longLine, theme, 80).join("\n")).includes("printf"), "budget fallback must not hide the command");
  const error = read.renderResult!({ content: [{ type: "text", text: "Permission denied" }], details: undefined }, { expanded: true, isPartial: false }, theme,
    { ...readContext, isError: true } as never).render(80).join("\n");
  assert(error.includes(theme.fg("error", "Permission denied")), "read errors retain diagnostic colors");

  // Exercise Pi's actual tool-card lifecycle and theme selection, not just callbacks.
  await mkdir(join(root, "themes"));
  await writeFile(join(root, "themes/gruvbox-dark.json"), JSON.stringify(palette));
  initTheme("gruvbox-dark", false);
  const ui = { requestRender() {} } as TUI;
  const purpose = "Verify shell quoting";
  const shellCard = new ToolExecutionComponent("bash", "native-shell", { command, purpose }, undefined, bash, ui, root);
  shellCard.setArgsComplete();
  const cardText = (card: ToolExecutionComponent) => card.render(160).map((line) => plain(line).trimEnd()).join("\n");
  assert(cardText(shellCard).includes(`• Command · ${purpose}\n`), "prepared arguments do not claim execution finished");
  assert(!cardText(shellCard).includes("Ran command"));
  shellCard.markExecutionStarted();
  assert(cardText(shellCard).includes(`• Running command · ${purpose}`));
  assert(shellCard.render(160).join("\n").includes(highlightSyntax(command, "bash")!.join("\n")));
  shellCard.updateResult({ content: [{ type: "text", text: "first output" }], isError: false }, true);
  assert(cardText(shellCard).includes("• Running command"));
  shellCard.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
  assert(cardText(shellCard).includes(`• Ran command · ${purpose}`));
  assert(cardText(shellCard).includes("  └ done"));

  // Observe the native card's final terminal cells: the inset ends at the panel,
  // its syntax colors survive, and output starts on the normal background.
  const terminal = new headless.Terminal({ cols: 160, rows: 20, allowProposedApi: true });
  const nativeRows = shellCard.render(160);
  await new Promise<void>((resolve) => terminal.write(nativeRows.join("\r\n"), resolve));
  const panelIndex = nativeRows.findIndex((line) => plain(line).startsWith("  │ "));
  const outputIndex = nativeRows.findIndex((line) => plain(line).startsWith("  └ done"));
  assert(panelIndex >= 0 && outputIndex > panelIndex);
  const panelLine = terminal.buffer.active.getLine(panelIndex)!;
  const purposeIndex = nativeRows.findIndex((line) => plain(line).includes(purpose));
  const purposeLine = terminal.buffer.active.getLine(purposeIndex)!;
  const purposeColumn = plain(nativeRows[purposeIndex]!).indexOf(purpose);
  assert(!purposeLine.getCell(purposeColumn)!.isBgRGB(), "purpose is separate from the command panel");
  assert.equal(purposeLine.getCell(purposeColumn)!.getFgColor(), 0xebdbb2, "purpose uses warm cream, not another accent");
  assert(panelLine.getCell(2)!.isBgRGB());
  assert.equal(panelLine.getCell(2)!.getBgColor(), 0x3c3836);
  assert.equal(panelLine.getCell(159)!.getBgColor(), 0x3c3836, "panel shades the full inset width");
  assert(!panelLine.getCell(0)!.isBgRGB(), "outer margin is unshaded");
  assert(!terminal.buffer.active.getLine(outputIndex)!.getCell(4)!.isBgRGB(), "command shade must not leak into output");
  assert(panelLine.getCell(4)!.isFgRGB(), "actual shell tokens keep RGB syntax color");
  terminal.dispose();

  const replay = new ToolExecutionComponent("bash", "replayed-shell", JSON.parse(JSON.stringify({ command, purpose })), undefined, bash, ui, root);
  replay.setArgsComplete();
  replay.updateResult({ content: [{ type: "text", text: "saved output" }], isError: false });
  assert(cardText(replay).includes(`• Ran command · ${purpose}`), "saved tool arguments restore the purpose without a new model call");

  const failedCard = new ToolExecutionComponent("bash", "native-failed", { command: "false" }, undefined, bash, ui, root);
  failedCard.updateResult({ content: [{ type: "text", text: "Command exited with code 1" }], isError: true });
  assert(cardText(failedCard).includes("• Command failed\n"));
  assert(!cardText(failedCard).includes("failed command"));
  assert(cardText(failedCard).includes("Command exited with code 1"));

  const managedCard = new ToolExecutionComponent("bash", "native-managed", { command: "printf output" }, undefined, bash, ui, root);
  managedCard.markExecutionStarted();
  const managedResult = { content: [{ type: "text", text: "✓ Shell command · running · 1s · exit 0\nJob: active123 · cursor: 16\n\njob output" }],
    details: { managed: true, status: "running", exitCode: 0, more: true }, isError: false };
  managedCard.updateResult(managedResult, true);
  assert(cardText(managedCard).includes("Job: active123"));
  assert(!cardText(managedCard).includes("cursor:"));
  assert(cardText(managedCard).includes("job output"));
  managedCard.setExpanded(true);
  assert(cardText(managedCard).includes("cursor: 16"), "expanded managed-job metadata remains intact");
  const readCard = new ToolExecutionComponent("read", "native-read", readContext.args, undefined, read, ui, root);
  readCard.setArgsComplete();
  readCard.updateResult({ ...content, isError: false });
  readCard.setExpanded(true);
  assert(readCard.render(160).join("\n").includes(highlightSyntax(code, "typescript")![0]!));
  for (let width = 0; width <= 200; width++) {
    for (const card of [shellCard, readCard, failedCard, managedCard]) assert(card.render(width).every((line) => visibleWidth(line) <= width));
  }
  handlers.get("session_shutdown")!({}, {});
  assert.equal(highlightSyntax(command, "bash"), undefined, "shutdown releases the extension's highlighter");
  assert(renderCommand(command).join("\n").includes(nativeCommand(theme)), "detached renders retain the native fallback");
  console.log("Tool Shiki colors, native fallback, source, diff backgrounds and widths verified");
} finally { await rm(root, { recursive: true, force: true }); }
