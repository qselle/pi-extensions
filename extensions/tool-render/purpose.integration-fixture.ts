import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createLsToolDefinition,
  createGrepToolDefinition, createFindToolDefinition, initTheme, SessionManager, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { groupState } from "./exploration.ts";
import { hasDanglingLink, setHyperlinkMode } from "../../lib/links.ts";

const root = await mkdtemp(join(tmpdir(), "pi-native-purposes-"));
process.env.PI_CODING_AGENT_DIR = root;
initTheme("dark", false);
setHyperlinkMode("always");
try {
  const { default: register } = await import("./index.ts");
  const tools = new Map<string, ToolDefinition<any>>();
  const handlers = new Map<string, Function>();
  register({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {},
    on: (name: string, handler: Function) => handlers.set(name, handler) } as never);
  const session = SessionManager.inMemory(root);
  const context = { cwd: root, mode: "json", sessionManager: session };
  await handlers.get("session_start")!({}, context);
  await writeFile(join(root, "source.txt"), "first\n");
  const examples = [
    ["read", createReadToolDefinition, { path: "source.txt" }, "Inspect current configuration"],
    ["write", createWriteToolDefinition, { path: "written.txt", content: "written\n" }, "Add the default configuration"],
    ["edit", createEditToolDefinition, { path: "source.txt", edits: [{ oldText: "first", newText: "second" }] }, "Correct the default value"],
    ["ls", createLsToolDefinition, { path: "." }, "Locate the configuration directory"],
    ["grep", createGrepToolDefinition, { pattern: "second", path: "." }, "Find the configuration consumers"],
    ["find", createFindToolDefinition, { pattern: "*.txt", path: "." }, "Locate matching configuration files"],
  ] as const;
  const ui = { requestRender() {} } as TUI;
  for (const [name, factory, args, purpose] of examples) {
    const tool = tools.get(name)!;
    const native = factory(root);
    const { purpose: _purpose, ...properties } = tool.parameters.properties;
    assert.deepEqual(properties, native.parameters.properties, `${name} keeps its original arguments`);
    assert.deepEqual(tool.parameters.required, native.parameters.required);
    assert.deepEqual(tool.promptGuidelines, native.promptGuidelines, "file captions need no extra prompt guideline");
    if (name === "edit") {
      assert.deepEqual(tool.prepareArguments!({ path: "source.txt", oldText: "first", newText: "second", purpose }),
        { path: "source.txt", edits: [{ oldText: "first", newText: "second" }], purpose }, "native edit normalization retains optional purpose");
    }
    assert.equal(Object.keys(tool.parameters.properties)[0], "purpose");
    for (const extra of [{}, { purpose: null }, { purpose }] as Array<Record<string, string | null>>) {
      const validated = validateToolArguments(tool, { type: "toolCall", name, id: `schema-${name}`, arguments: { ...args, ...extra } });
      assert.deepEqual(validated, extra.purpose ? { ...args, purpose } : args);
    }
    const decorated = { ...args, purpose };
    const before = JSON.stringify(decorated);
    const result = name === "find" || name === "grep"
      ? { content: [{ type: "text" as const, text: "source.txt:1: second" }], details: undefined }
      : await tool.execute(`execute-${name}`, decorated, undefined, undefined, context as never);
    assert.equal(JSON.stringify(decorated), before, "display metadata does not mutate execution arguments");
    const card = new ToolExecutionComponent(name, `card-${name}`, decorated, undefined, tool, ui, root);
    card.setArgsComplete();
    card.markExecutionStarted();
    const rendered = () => card.render(180).map(plain).join("\n");
    assert(rendered().includes(purpose), `${name} shows intent while running`);
    card.updateResult({ ...result, isError: false });
    assert.equal(rendered().split(purpose).length - 1, 1, `${name} shows one completed purpose heading`);
    card.setExpanded(true);
    assert.equal(rendered().split(purpose).length - 1, 1, `${name} does not duplicate the expanded heading`);
    for (const width of [0, 1, 4, 12, 40, 80, 120, 180]) assert(card.render(width).every((row) => visibleWidth(row) <= width && !hasDanglingLink(row)));
    const replay = new ToolExecutionComponent(name, `replay-${name}`, JSON.parse(before), undefined, tool, ui, root);
    replay.updateResult({ ...result, isError: false });
    assert(replay.render(180).map(plain).join("\n").includes(purpose), `${name} restores intent from saved arguments`);
  }
  assert.equal(await readFile(join(root, "source.txt"), "utf8"), "second\n");
  assert.equal(await readFile(join(root, "written.txt"), "utf8"), "written\n");
  const shared = "Inspect the configuration inputs";
  const calls = ["first", "second"].map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: `${id}.ts`, purpose: shared } }));
  session.appendMessage({ role: "assistant", content: calls, stopReason: "toolUse", timestamp: 1 } as never);
  const results = calls.map((call) => ({ role: "toolResult" as const, toolCallId: call.id, toolName: "read", content: [{ type: "text" as const, text: "content" }], isError: false, timestamp: 2 }));
  for (const result of results) session.appendMessage(result);
  await handlers.get("session_start")!({}, context);
  const read = tools.get("read")!;
  const leader = new ToolExecutionComponent("read", calls[0]!.id, calls[0]!.arguments, undefined, read, ui, root);
  leader.updateResult(results[0]!);
  assert.equal(leader.render(180).map(plain).join("\n").split(shared).length - 1, 1, "a common exploration intent belongs in the shared heading once");
  assert.equal(groupState(calls[0]!.id)?.rows[1]?.purpose, shared);
  await handlers.get("session_shutdown")!({}, context);
  console.log("native file schemas, purpose captions, execution and replay verified");
} finally { await rm(root, { recursive: true, force: true }); }
