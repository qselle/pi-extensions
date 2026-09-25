import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { initTheme, SessionManager, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { hasDanglingLink, setHyperlinkMode } from "../../lib/links.ts";
import { groupOf, groupState } from "./exploration.ts";
import { compactPath } from "./render.ts";

const root = await mkdtemp(join(tmpdir(), "pi-exploration-replay-"));
process.env.PI_CODING_AGENT_DIR = root;
initTheme("dark", false);
setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o" } }));
setHyperlinkMode("always");
try {
  const { default: register } = await import("./index.ts");
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Function>();
  register({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {},
    on: (name: string, handler: Function) => handlers.set(name, handler) } as never);
  let session = SessionManager.create(root, root);
  const firstUser = session.appendMessage({ role: "user", content: "Inspect the project", timestamp: 1 });
  const calls = Array.from({ length: 9 }, (_, index) => ({ type: "toolCall" as const, id: `read-${index}`, name: "read",
    arguments: { path: `src/a-long-component-directory/nested/file-${index}.ts` } }));
  const assistant = (content: unknown[]) => ({ role: "assistant", content, api: "openai-responses", provider: "openai", model: "fixture",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 2 });
  session.appendMessage(assistant(calls) as never);
  const results = calls.map((call, index) => ({ role: "toolResult" as const, toolCallId: call.id, toolName: call.name,
    content: [{ type: "text" as const, text: index === 1 ? "Permission denied\nTry another readable file" : `const file${index} = true;` }],
    isError: index === 1, timestamp: index + 3 }));
  let firstLeaf = "";
  for (const result of results) firstLeaf = session.appendMessage(result);
  // Reload the actual JSONL, not only synthetic arrays.
  session = SessionManager.open(session.getSessionFile()!);
  const ui = { requestRender() {} } as TUI;
  const context = () => ({ cwd: root, mode: "rpc", sessionManager: session });
  const fire = async (event: string) => handlers.get(event)!({}, context());
  const card = (call: typeof calls[number], result = results.find((entry) => entry.toolCallId === call.id)!) => {
    const component = new ToolExecutionComponent(call.name, call.id, call.arguments, undefined, tools.get(call.name), ui, root);
    component.updateResult(result);
    return component;
  };
  const text = (component: ToolExecutionComponent, width = 100) => component.render(width).map(plain).join("\n");
  // Pi rebuilds cards before session_start on /reload. Already-created render
  // closures must adopt restored groups without replacing the host components.
  const beforeReload = card(calls[0]!);
  assert(!text(beforeReload).includes("Explored"));
  const savedBefore = JSON.stringify(session.getEntries());
  await fire("session_start");
  assert.equal(JSON.stringify(session.getEntries()), savedBefore, "restoration does not write metadata or change stored results");
  assert(text(beforeReload).includes("Explored"));
  const cards = calls.map((call) => card(call));
  const collapsed = text(cards[0]!);
  assert(collapsed.includes("4 more steps") && collapsed.includes("to expand"), collapsed);
  assert(collapsed.includes("Permission denied"), "an early failure stays in the collapsed viewport");
  assert(collapsed.includes("file-8.ts"), "recent work stays visible");
  assert(!collapsed.includes("file-0.ts"), "older successes can leave the viewport");
  assert(cards[0]!.render(100).length <= 8, "nine calls remain one bounded native card");
  assert(text(cards[1]!).includes("Try another readable file"), "collapsed failed followers retain diagnostics");
  assert.equal(text(cards[2]!), "", "successful followers are represented by their leader");
  const group = groupOf(calls[0]!.id)!;
  const groupedCalls = group.calls;
  let groupScans = 0;
  Object.defineProperty(group, "calls", { configurable: true, get: () => { groupScans++; return groupedCalls; } });
  assert.equal(text(cards[2]!), "");
  assert(text(cards[1]!).includes("Try another readable file"));
  assert.equal(groupScans, 0, "repainting followers must not scan all calls in their group");
  Object.defineProperty(group, "calls", { configurable: true, writable: true, value: groupedCalls });
  const allFailed = calls.map((call) => ({ ...results[1]!, toolCallId: call.id }));
  // Replaying seven hidden failures must not make the group appear successful.
  const failureSession = SessionManager.inMemory(root);
  failureSession.appendMessage(assistant(calls) as never);
  for (const result of allFailed) failureSession.appendMessage(result);
  await handlers.get("session_tree")!({}, { ...context(), sessionManager: failureSession });
  assert(text(card(calls[0]!, allFailed[0])).includes("4 more steps (4 failed)"));
  await fire("session_tree");
  for (const width of [0, 1, 2, 4, 10, 20, 40, 80, 120, 180]) {
    for (const component of cards) {
      assert(component.render(width).every((row) => visibleWidth(row) <= width && !hasDanglingLink(row)), `collapsed overflow/link at ${width}`);
      component.setExpanded(true);
      const lines = component.render(width);
      assert(lines.every((row) => visibleWidth(row) <= width && !hasDanglingLink(row)), `expanded overflow/link at ${width}`);
      component.setExpanded(false);
    }
  }
  for (const [index, component] of cards.entries()) {
    component.setExpanded(true);
    assert(text(component).includes(index === 1 ? "Try another readable file" : `const file${index} = true;`));
    component.setExpanded(false);
  }
  assert(text(cards[0]!, 40).includes("file-8.ts"), "narrow paths retain the filename");
  assert(cards[0]!.render(100).join("\n").includes(encodeURI(join(root, calls[8]!.arguments.path))), "links retain the full target");
  for (const width of Array.from({ length: 65 }, (_, index) => index)) {
    for (const path of ["src/very/long/目录/家庭👨‍👩‍👧‍👦.ts", "目录/🌍.ts", "very-long-界🌍-filename.extension"]) {
      const label = compactPath(path, width);
      assert(visibleWidth(label) <= width, `Unicode path overflow at ${width}: ${label}`);
      assert(!label.includes("�"));
    }
  }
  session.branch(firstUser);
  await fire("session_tree");
  assert.equal(groupState(calls[0]!.id), undefined);
  assert(!text(cards[0]!).includes("Explored"), "old cards cannot retain another branch's group");
  session.branch(firstLeaf);
  await fire("session_tree");
  assert(text(cards[0]!).includes("Explored"));
  const laterCalls = [{ ...calls[0]!, id: "later-a" }, { ...calls[1]!, id: "later-b" }];
  const retainedAssistant = session.appendMessage(assistant(laterCalls) as never);
  const laterResults = laterCalls.map((call) => ({ ...results[0]!, toolCallId: call.id }));
  for (const result of laterResults) session.appendMessage(result);
  session.appendCompaction("Keep the next files", retainedAssistant, 12_000);
  await fire("session_compact");
  assert.equal(groupState(calls[0]!.id), undefined, "compacted-away calls cannot own visible groups");
  assert.equal(groupState("later-a")?.rows.length, 2);
  assert(text(card(laterCalls[0]!, laterResults[0])).includes("Explored"));
  assert.equal(text(card(laterCalls[1]!, laterResults[1])), "");
  const verbose = new ToolExecutionComponent("bash", "verbose", { command: "test" }, undefined, tools.get("bash"), ui, root);
  verbose.updateResult({ content: [{ type: "text", text: Array.from({ length: 300 }, (_, index) => `output ${index}`).join("\n") }], isError: false });
  assert(text(verbose).includes("to expand"));
  verbose.setExpanded(true);
  assert(text(verbose).includes("preview limit") && !text(verbose).includes("to expand"));
  const written = new ToolExecutionComponent("write", "written", { path: "file.txt", content: "line\n".repeat(500) }, undefined, tools.get("write"), ui, root);
  written.updateResult({ content: [{ type: "text", text: "Written" }], isError: false });
  assert(text(written).includes("to expand"), "collapsed diffs disclose their expansion action");
  written.setExpanded(true);
  assert(text(written).includes("preview limit") && !text(written).includes("to expand"));
  // An incomplete/older host projection must leave native standalone cards.
  await handlers.get("session_tree")!({}, { sessionManager: { buildContextEntries() { throw new Error("unavailable"); } } });
  assert.equal(groupState("later-a"), undefined);
  assert(text(card(laterCalls[1]!, laterResults[1])).includes("Read"));
  await handlers.get("session_shutdown")!({}, context());
  console.log("native exploration replay, bounded previews, links and expansion verified");
} finally {
  await rm(root, { recursive: true, force: true });
}
