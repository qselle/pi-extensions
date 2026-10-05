/** Reproduce native saved-history rendering costs; timings are informational. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, SessionManager, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";

const directory = await mkdtemp(join(tmpdir(), "pi-tool-history-benchmark-"));
process.env.PI_CODING_AGENT_DIR = directory;
initTheme("dark", false);
setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o" } }));
const measure = <T>(run: () => T) => {
  const start = performance.now();
  const value = run();
  return { milliseconds: +(performance.now() - start).toFixed(2), value };
};
const memory = () => ({ heap: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss });
try {
  const { default: register } = await import("./index.ts");
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Function>();
  register({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {},
    on: (name: string, handler: Function) => handlers.set(name, handler) } as never);
  const ui = { requestRender() {} } as TUI;
  const reports = [];
  for (const groupSize of [50, 1000]) {
    const before = memory();
    let session = SessionManager.create(directory, directory);
    session.appendMessage({ role: "user", content: "Inspect the project", timestamp: 1 });
    const calls = Array.from({ length: 1000 }, (_, index) => ({ type: "toolCall" as const, id: `read-${index}`, name: "read",
      arguments: { path: `src/long-component-directory/nested/file-${index}.txt`, purpose: "Inspect the configuration inputs" } }));
    const results = calls.map((call, index) => ({ role: "toolResult" as const, toolCallId: call.id, toolName: call.name,
      content: [{ type: "text" as const, text: index % 97 === 1 ? "Permission denied\nTry another readable file" : `setting ${index}\nvalue enabled\n` }],
      isError: index % 97 === 1, timestamp: index + 3 }));
    for (let index = 0; index < calls.length; index += groupSize) {
      session.appendMessage({ role: "assistant", content: calls.slice(index, index + groupSize), api: "openai-responses", provider: "openai", model: "fixture",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp: index + 2 } as never);
      for (const result of results.slice(index, index + groupSize)) session.appendMessage(result);
    }
    const reopened = measure(() => SessionManager.open(session.getSessionFile()!));
    session = reopened.value;
    const context = { cwd: directory, mode: "json", sessionManager: session };
    // Match native reload order: Pi builds components before session_start.
    const created = measure(() => calls.map((call, index) => {
      const component = new ToolExecutionComponent(call.name, call.id, call.arguments, undefined, tools.get(call.name), ui, directory);
      component.updateResult(results[index]!);
      return component;
    }));
    const cards = created.value;
    const start = performance.now();
    await handlers.get("session_start")!({}, context);
    const restoreMs = +(performance.now() - start).toFixed(2);
    const render = (width: number, verify = false) => {
      let rows = 0;
      let visibleCards = 0;
      for (const card of cards) {
        const lines = card.render(width);
        rows += lines.length;
        if (lines.length) visibleCards++;
        if (verify) assert(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
      }
      return { rows, visibleCards };
    };
    const collapsed = measure(() => render(120, true));
    const repaint = measure(() => { for (let index = 0; index < 20; index++) render(120); });
    const resized = measure(() => Array.from({ length: 3 }, () => [40, 80, 120, 180].map((width) => ({ width, ...render(width) }))));
    for (const card of cards) card.setExpanded(true);
    const expanded = measure(() => render(120, true));
    assert.equal(expanded.value.visibleCards, 1000, "expansion restores every individual output");
    assert(collapsed.value.visibleCards < 50, "collapsed history is bounded by group leaders and failed diagnostics");
    for (const card of cards) card.setExpanded(false);
    const recollapsed = measure(() => render(120));
    assert.deepEqual(recollapsed.value, collapsed.value);
    const after = memory();
    reports.push({ calls: 1000, groups: 1000 / groupSize, groupSize, savedEntries: session.getEntries().length,
      reopenMs: reopened.milliseconds, createCardsMs: created.milliseconds, restoreMs,
      collapsed: { milliseconds: collapsed.milliseconds, ...collapsed.value },
      repeatedPaints: { count: 20, totalMs: repaint.milliseconds, averageMs: +(repaint.milliseconds / 20).toFixed(2) },
      resizePaints: { count: 12, totalMs: resized.milliseconds, averageMs: +(resized.milliseconds / 12).toFixed(2), rowCounts: resized.value[0] },
      expanded: { milliseconds: expanded.milliseconds, ...expanded.value },
      recollapseMs: recollapsed.milliseconds,
      memoryDeltaMiB: { heap: +((after.heap - before.heap) / 1024 ** 2).toFixed(2), rss: +((after.rss - before.rss) / 1024 ** 2).toFixed(2) },
    });
    await handlers.get("session_shutdown")!({}, context);
  }

  // Highlighted history: settled shell and edit cards under the Shiki-backed
  // theme. Each repaint re-renders every card, as the TUI does every frame.
  const themeSource = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "modes/interactive/theme/dark.json");
  await mkdir(join(directory, "themes"), { recursive: true });
  await writeFile(join(directory, "themes", "gruvbox-dark.json"), JSON.stringify({ ...JSON.parse(await readFile(themeSource, "utf8")), name: "gruvbox-dark" }));
  initTheme("gruvbox-dark", false);
  const highlightedContext = { cwd: directory, mode: "tui", sessionManager: SessionManager.inMemory(directory) };
  await handlers.get("session_start")!({}, highlightedContext);
  const commandCards = Array.from({ length: 800 }, (_, index) => {
    const id = index % 4 === 3 ? `edit-${index}` : `bash-${index}`;
    const name = id.startsWith("edit") ? "edit" : "bash";
    const args = name === "bash"
      ? { command: `cd packages/app-${index} && bun test --filter "render ${index}" | tee "/tmp/out-${index}.log"\nprintf '%s\\n' "$PWD"`, purpose: "Check the renderer tests" }
      : { path: `src/module-${index}.ts`, edits: [{ oldText: "a - b", newText: "a + b" }] };
    const patch = `--- a\n+++ b\n@@ -1,3 +1,3 @@\n export function add${index}(a: number, b: number) {\n-  return a - b;\n+  return a + b;\n }`;
    const card = new ToolExecutionComponent(name, id, args, undefined, tools.get(name), ui, directory);
    card.updateResult({ role: "toolResult", toolCallId: id, toolName: name, isError: false, timestamp: index,
      content: [{ type: "text", text: name === "bash" ? `ok ${index}\n12 pass\n0 fail` : "Edited" }], details: name === "edit" ? { patch } : undefined } as never);
    return card;
  });
  const paintCommands = (width: number) => commandCards.reduce((rows, card) => rows + card.render(width).length, 0);
  const firstPaint = measure(() => paintCommands(120));
  const commandRepaint = measure(() => { for (let index = 0; index < 20; index++) paintCommands(120); });
  const commandResize = measure(() => { for (let index = 0; index < 3; index++) for (const width of [40, 80, 120, 180]) paintCommands(width); });
  reports.push({ calls: commandCards.length, scenario: "highlighted bash/edit cards", firstPaintMs: firstPaint.milliseconds, rows: firstPaint.value,
    repeatedPaints: { count: 20, totalMs: commandRepaint.milliseconds, averageMs: +(commandRepaint.milliseconds / 20).toFixed(2) },
    resizePaints: { count: 12, totalMs: commandResize.milliseconds, averageMs: +(commandResize.milliseconds / 12).toFixed(2) } } as never);
  await handlers.get("session_shutdown")!({}, highlightedContext);
  console.log(JSON.stringify({ runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`, platform: `${process.platform}/${process.arch}`, reports,
    notes: ["1000 calls reopened from native session JSONL; no model or external command execution.",
      "Memory deltas include cards/session/render allocations and GC variability, not retained-memory claims.",
      "Renderer timings exclude terminal I/O; expanded text fixtures deliberately avoid grammar initialization."] }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
