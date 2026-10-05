/** Card rendering behaviors verified through Pi's native tool component. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const plainTheme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as never;
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

  // 2. Overwrites diff against the previous content; new files are all added.
  {
    const write = tools.get("write")!;
    const run = async (id: string, args: Record<string, unknown>) => {
      const result = await write.execute(id, args, undefined, undefined, context as never);
      const view = card("write", id, args);
      view.updateResult({ ...result, isError: false } as never);
      return { result, rows: view.render(100).map(plain) };
    };
    const original = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
    const created = await run("write-new", { path: "ten.txt", content: `${original.join("\n")}\n` });
    assert(created.rows[1]!.includes("Wrote ten.txt (+10)"), created.rows[1]);
    assert.equal(created.result.details, undefined, "new files keep native details");
    const changed = original.with(4, "line five");
    const overwrite = await run("write-over", { path: "ten.txt", content: `${changed.join("\n")}\n`, purpose: "Rename one line" });
    assert(overwrite.rows[1]!.includes("(+1 -1)"), overwrite.rows[1]);
    assert.equal(await readFile(join(root, "ten.txt"), "utf8"), `${changed.join("\n")}\n`);
    const body = overwrite.rows.slice(2).join("\n");
    assert(body.includes("- line 5") && body.includes("+ line five") && body.includes("line 4"), body);
    assert(!/line 10\s*$/m.test(body), "distant unchanged lines are not shown");

    const many = Array.from({ length: 1200 }, (_, index) => `old ${index}`).join("\n");
    await writeFile(join(root, "big.txt"), many);
    const rewritten = await run("write-big", { path: "big.txt", content: many.replace(/old/g, "new") });
    const details = rewritten.result.details as { patch: string; added: number; removed: number; omittedRows: number };
    assert.equal(details.added, 1200);
    assert.equal(details.removed, 1200);
    assert(details.patch.split("\n").length < 420, "saved patches are bounded");
    assert.equal(details.omittedRows, 2000);
    assert(rewritten.rows[1]!.includes("(+1200 -1200)"));
    assert(rewritten.rows.join("\n").includes("+2388 lines"), "omitted rows include unsaved patch rows");
  }

  // 3. Streaming write/edit arguments render before execution starts.
  {
    const streaming = card("write", "stream-write", { path: "src/new.ts", content: "a\nb" });
    assert.equal(text(streaming.render(80)), "\n• Writing src/new.ts · 2 lines");
    streaming.updateArgs({ path: "src/new.ts", content: "a\nb\nc" });
    assert(text(streaming.render(80)).includes("Writing src/new.ts · 3 lines"), "growing arguments refresh");
    const write = tools.get("write")!;
    const direct = write.renderCall!({}, plainTheme, { args: { path: "x.ts", content: "1\n2\n3\n" }, isPartial: true, executionStarted: false } as never);
    assert(text(direct.render(80)).includes("3 lines"));
    const editing = card("edit", "stream-edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c" }] });
    assert(text(editing.render(80)).includes("Editing src/a.ts · 2 edits"));
    editing.markExecutionStarted();
    assert(text(editing.render(80)).includes("Editing src/a.ts · 2 edits"));
    editing.updateResult({ content: [{ type: "text", text: "ok" }], details: { patch: "@@ -1 +1 @@\n-a\n+b" }, isError: false } as never);
    const done = text(editing.render(80));
    assert(done.includes("Edited src/a.ts (+1 -1)") && !done.includes("edits"), done);
  }

  // 4. Saved `reasoning` captions render like `purpose`; neither reaches execution.
  {
    const reasoning = "Check the session settings";
    for (const [name, args, result] of [
      ["bash", { command: "true", reasoning }, ""],
      ["write", { path: "r.txt", content: "r", reasoning }, "ok"],
      ["read", { path: "r.txt", reasoning }, "r"],
    ] as const) {
      const view = card(name, `reasoning-${name}`, args);
      view.updateResult({ content: [{ type: "text", text: result }], details: undefined, isError: false } as never);
      assert(text(view.render(120)).includes(reasoning), `${name} shows a reasoning caption`);
    }
    const preferred = card("read", "reasoning-both", { path: "r.txt", purpose: "Inspect the defaults", reasoning });
    preferred.updateResult({ content: [{ type: "text", text: "r" }], details: undefined, isError: false } as never);
    assert(text(preferred.render(120)).includes("Inspect the defaults") && !text(preferred.render(120)).includes(reasoning));
    const args = { path: "meta.txt", content: "exact", purpose: "Save metadata", reasoning };
    const written = await tools.get("write")!.execute("strip", args, undefined, undefined, context as never);
    assert.equal(await readFile(join(root, "meta.txt"), "utf8"), "exact");
    assert(!JSON.stringify(written).includes(reasoning));
    assert.deepEqual(args, { path: "meta.txt", content: "exact", purpose: "Save metadata", reasoning }, "saved arguments are not mutated");
    const read = await tools.get("read")!.execute("strip-read", { path: "meta.txt", reasoning }, undefined, undefined, context as never);
    assert(JSON.stringify(read.content).includes("exact"));
  }

  await handlers.get("session_shutdown")!({}, context);
  console.log("tool-render cards verified");
} finally { await rm(root, { recursive: true, force: true }); }
