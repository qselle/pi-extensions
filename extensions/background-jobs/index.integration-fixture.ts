import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const tools = new Map<string, any>();
const commands = new Map<string, any>();
const entries: any[] = [];
const handlers = new Map<string, Function>();
extension({
  appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand: (name: string, tool: any) => commands.set(name, tool),
  on: (name: string, callback: Function) => handlers.set(name, callback),
  getThinkingLevel: () => "high", events: { emit() {}, on() { return () => {}; } },
} as never);
const root = await mkdtemp(join(tmpdir(), "pi-jobs-tools-"));
const ctx = { mode: "json", cwd: root, model: { provider: "fixture-provider", id: "fixture-model" },
  sessionManager: { getBranch: () => entries, getSessionId: () => "fixture-session", getSessionFile: () => undefined },
  ui: { notify() {} },
};
try {
  await handlers.get("session_start")!({}, ctx);
  assert.deepEqual([...tools.keys()], ["bash", "job_start", "job_output", "job_wait", "job_list", "job_write", "job_resize", "job_stop"]);
  assert(commands.has("jobs") && commands.has("ps"));
  const start = tools.get("job_start");
  const result = await start.execute("call", {
    name: "Metadata check", command: 'printf "%s|%s|%s|%s" "$PI_SESSION_ID" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"', yield_ms: 3000,
  }, undefined, undefined, ctx);
  assert.equal(result.details.status, "completed");
  assert(result.content[0].text.includes("fixture-session|fixture-provider|fixture-model|high"));
  const output = await tools.get("job_output").execute("read", { id: result.details.id, cursor: result.details.cursor });
  assert(output.content[0].text.includes("No new output"));
  const theme = { fg: (_: string, text: string) => text };
  for (const width of [1, 20, 80]) {
    const lines = start.renderResult(result, { expanded: false, isPartial: false }, theme).render(width);
    assert(lines.every((line: string) => visibleWidth(line) <= width));
  }
  const running = await start.execute("second", { name: "Cleanup", command: "cat", yield_ms: 0 }, undefined, undefined, ctx);
  let invalidations = 0;
  const renderContext = { state: {}, invalidate: () => invalidations++ };
  const options = { expanded: true, isPartial: false };
  start.renderResult(running, options, theme, renderContext);
  start.renderResult(running, options, theme, renderContext);
  const original = tools.get("job_output").renderResult(running, options, theme).render(100).join("\n");
  await tools.get("job_write").execute("write", { id: running.details.id, text: "hello\n", eof: true });
  const waited = await tools.get("job_wait").execute("wait", { id: running.details.id, cursor: 0, wait_ms: 3000 });
  assert.equal(waited.details.status, "completed");
  assert(waited.content[0].text.includes("hello"));
  assert.equal(invalidations, 1);
  const finalCard = start.renderResult(running, options, theme, renderContext).render(100).join("\n");
  assert(finalCard.includes("completed") && finalCard.includes("hello"));
  assert.equal(tools.get("job_output").renderResult(running, options, theme).render(100).join("\n"), original);
  assert.equal(entries.filter((entry) => entry.data.id === running.details.id).length, 2);
  const cleanup = await start.execute("cleanup", { name: "Stop on reload", command: "cat", yield_ms: 0 }, undefined, undefined, ctx);
  await handlers.get("session_shutdown")!({}, ctx);
  assert.equal(entries.filter((entry) => entry.data.id === cleanup.details.id).at(-1).data.status, "stopped");
  await handlers.get("session_start")!({}, ctx);
  const restored = await tools.get("job_output").execute("restored", { id: running.details.id, cursor: 0 });
  assert.equal(restored.details.status, "completed");
  assert(restored.content[0].text.includes("Historical record") && restored.content[0].text.includes("hello"));
  assert.equal(start.renderResult(running, options, theme).render(100).join("\n"), finalCard);
  const stopped = await tools.get("job_stop").execute("repeat-stop", { id: cleanup.details.id });
  assert.equal(stopped.details.status, "stopped");
  await handlers.get("session_shutdown")!({}, ctx);
  console.log("job tools, metadata, rendering and lifecycle verified");
} finally {
  await handlers.get("session_shutdown")!({}, ctx);
  await rm(root, { recursive: true, force: true });
}
