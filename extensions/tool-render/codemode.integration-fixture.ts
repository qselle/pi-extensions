/** Codemode restyling verified with Pi's real codemode extension and tool component. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { initTheme, SessionManager, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";

const root = await mkdtemp(join(tmpdir(), "pi-tool-render-codemode-"));
process.env.PI_CODING_AGENT_DIR = root;
initTheme("dark", false);
setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o" } }));
try {
  const { default: register } = await import("./index.ts");
  const { INTENT_GUIDELINE } = await import("./codemode.ts");
  const { renderCacheStats } = await import("./lines.ts");
  const tools = new Map<string, ToolDefinition<any>>();
  const sources = new Map<string, string>([["codemode", "builtin:codemode"]]);
  const handlers = new Map<string, Function>();
  register({
    registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); sources.set(tool.name, "extension:tool-render"); },
    registerCommand() {},
    on: (name: string, handler: Function) => handlers.set(name, handler),
    getAllTools: () => [...sources].map(([name, path]) => ({ name, sourceInfo: { path } })),
    getSettings: () => ({}),
    appendEntry() {},
  } as never);
  assert(!tools.has("codemode"), "codemode waits for session start");
  const context = { cwd: root, mode: "json", sessionManager: SessionManager.inMemory(root) };
  await handlers.get("session_start")!({}, context);
  await handlers.get("session_start")!({}, context);

  // 1. Pi's own definition, with renderers and the intent guideline added once.
  const tool = tools.get("codemode") as ToolDefinition<any> & { defaultActive?: boolean };
  assert(tool, "codemode was restyled");
  assert.equal(tool.renderShell, "self");
  assert.equal(tool.defaultActive, false);
  assert.match(tool.description, /JavaScript/);
  assert.equal(tool.promptGuidelines?.filter((line) => line === INTENT_GUIDELINE).length, 1);

  // 2. The call slot draws the whole card from the result slot's latest result.
  const ui = { requestRender() {} } as TUI;
  const code = "// Count files\nconst rows = await tools.bash({ command: 'ls' });\nreturn rows;";
  const card = new ToolExecutionComponent("codemode", "cm-1", { code }, undefined, tool, ui, root);
  card.markExecutionStarted();
  const running = { id: "cm-1/1", name: "bash", args: '{"purpose":"List files","command":"ls"}', status: "running" };
  card.updateResult({ content: [], details: { calls: [running] }, isError: false } as never, true);
  const live = card.render(80).map(plain);
  assert.equal(live[1], "• Running script to count files · 1 call", live.join("\n"));
  assert(live.at(-1)!.startsWith("  └ bash List files $ ls · …"), live.join("\n"));

  card.updateResult({
    content: [{ type: "text", text: "Script completed\nWall time 3.2 seconds\nOutput:\n" }, { type: "text", text: "a.txt\nb.txt" }],
    details: { calls: [{ ...running, status: "ok", durationMs: 40 }] },
    isError: false,
  } as never, false);
  const done = card.render(80);
  const rows = done.map(plain);
  assert.equal(rows[1], "• Ran script to count files · 1 call · ✓ in 3s");
  assert(rows.some((row) => row.includes("const rows = await tools.bash")));
  assert(!rows.some((row) => row.includes("// Count files")), "collapsed scripts hide the intent comment");
  assert.deepEqual(rows.slice(-3), ["  ├ bash List files $ ls · ✓", "  └ a.txt", "    b.txt"]);
  assert.equal(rows.filter((row) => row.includes("Ran script")).length, 1, "the result slot adds no second block");
  assert(done.every((row) => visibleWidth(row) <= 80));

  // 3. Settled cards repaint from their cache, byte-identically.
  const before = renderCacheStats.builds;
  assert.deepEqual(card.render(80), done);
  assert.equal(renderCacheStats.builds - before, 0);

  card.setExpanded(true);
  assert(card.render(80).map(plain).some((row) => row.includes("// Count files")), "expanded scripts keep the comment");

  await handlers.get("session_shutdown")!({}, context);
  console.log("tool-render codemode verified");
} finally { await rm(root, { recursive: true, force: true }); }
