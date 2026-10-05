/** Card rendering behaviors verified through Pi's native tool component. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { initTheme, SessionManager, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";

const root = await mkdtemp(join(tmpdir(), "pi-tool-render-cards-"));
process.env.PI_CODING_AGENT_DIR = root;
initTheme("dark", false);
setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o" } }));
try {
  const { default: register } = await import("./index.ts");
  const { renderCacheStats } = await import("./lines.ts");
  const tools = new Map<string, ToolDefinition<any>>();
  const handlers = new Map<string, Function>();
  register({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {},
    on: (name: string, handler: Function) => handlers.set(name, handler) } as never);
  const context = { cwd: root, mode: "json", sessionManager: SessionManager.inMemory(root) };
  await handlers.get("session_start")!({}, context);
  const ui = { requestRender() {} } as TUI;
  const card = (name: string, id: string, args: Record<string, unknown>) =>
    new ToolExecutionComponent(name, id, args, undefined, tools.get(name), ui, root);
  const text = (rows: string[]) => rows.map(plain).join("\n");
  const builds = (run: () => void) => {
    const before = renderCacheStats.builds;
    run();
    return renderCacheStats.builds - before;
  };

  // 1. Settled cards build once per width; running cards and changes rebuild.
  {
    const command = card("bash", "cache-bash", { command: "printf 'one\\ntwo'" });
    command.updateResult({ content: [{ type: "text", text: "one\ntwo" }], details: undefined, isError: false } as never);
    const first = command.render(80);
    assert.equal(builds(() => assert.deepEqual(command.render(80), first)), 0, "a settled card repaints from its cache");
    assert.equal(builds(() => command.render(60)), 2, "a new width builds the call and result once");
    assert.equal(builds(() => command.render(60)), 0);

    const running = card("bash", "cache-running", { command: "sleep 1" });
    running.markExecutionStarted();
    running.render(80);
    assert(builds(() => running.render(80)) > 0, "running cards refresh every frame");

    const collapsed = text(command.render(80));
    command.setExpanded(true);
    assert(builds(() => command.render(80)) > 0, "expansion rebuilds");
    command.setExpanded(false);
    command.updateResult({ content: [{ type: "text", text: "three" }], details: undefined, isError: false } as never);
    assert.notEqual(text(command.render(80)), collapsed, "a changed result rebuilds");
    assert(text(command.render(80)).includes("three"));

    const dark = command.render(80).join("\n");
    initTheme("light", false);
    command.invalidate();
    assert.notEqual(command.render(80).join("\n"), dark, "a theme change rebuilds");
    initTheme("dark", false);
    command.invalidate();

    // A settled group leader also depends on sibling calls that finish later.
    const fire = (name: string, event: object) => handlers.get(name)!(event, context);
    fire("tool_execution_start", { toolName: "read", toolCallId: "lead", args: { path: "a.txt" } });
    fire("tool_execution_end", { toolName: "read", toolCallId: "lead", isError: false, result: { content: [{ type: "text", text: "a" }] } });
    const leader = card("read", "lead", { path: "a.txt" });
    leader.updateResult({ content: [{ type: "text", text: "a" }], details: undefined, isError: false } as never);
    fire("tool_execution_start", { toolName: "read", toolCallId: "follow", args: { path: "b.txt" } });
    assert(text(leader.render(80)).includes("Reading b.txt"));
    fire("tool_execution_end", { toolName: "read", toolCallId: "follow", isError: false, result: { content: [{ type: "text", text: "1\n2" }] } });
    fire("agent_end", {});
    assert(text(leader.render(80)).includes("Explored"), "group changes are not hidden by the cache");
    assert(text(leader.render(80)).includes("2 lines"));
    // Tree navigation rebuilds groups without recreating or invalidating cards.
    fire("session_tree", {});
    assert(!text(leader.render(80)).includes("Explored"), "cleared groups are not hidden by the cache");
  }

  await handlers.get("session_shutdown")!({}, context);
  console.log("tool-render cards verified");
} finally { await rm(root, { recursive: true, force: true }); }
