/** Managed bash (background-jobs executor) rendered by tool-render cards, end to end. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

const root = await mkdtemp(join(tmpdir(), "pi-tool-render-managed-"));
process.env.PI_CODING_AGENT_DIR = root;
initTheme("dark", false);
try {
  const { default: background } = await import("../background-jobs/index.ts");
  const { default: renderer } = await import("./index.ts");
  const bus = new EventEmitter();
  const order = [background, renderer];
  const registered = order.map(() => new Map<string, any>());
  // An extension's re-registration replaces its own tool; across extensions the first one wins.
  const tools = { get: (name: string) => registered.map((map) => map.get(name)).find(Boolean) };
  const handlers = new Map<string, Function[]>();
  for (const [index, extension] of order.entries()) extension({
    registerTool: (tool: any) => registered[index]!.set(tool.name, tool),
    registerCommand() {}, getThinkingLevel: () => "off", appendEntry() {},
    events: { emit: (name: string, data: unknown) => bus.emit(name, data), on: (name: string, handler: any) => { bus.on(name, handler); return () => bus.off(name, handler); } },
    on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
  } as never);
  const ctx = { mode: "json", cwd: root, sessionManager: { getSessionId: () => "managed", getSessionFile: () => undefined, getBranch: () => [], buildContextEntries: () => [] }, ui: { notify() {} } };
  const fire = async (name: string, event: object = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  await fire("session_start");
  const bash = tools.get("bash");
  assert(bash.parameters.properties.yield_ms, "the managed executor owns bash");
  const ui = { requestRender() {} } as TUI;
  const card = (id: string, args: object, result: any, partial = false) => {
    const view = new ToolExecutionComponent("bash", id, args, undefined, bash, ui, root);
    view.markExecutionStarted();
    view.updateResult(result, partial);
    return view;
  };
  const rows = (view: ToolExecutionComponent, width = 100) => view.render(width).map(plain).slice(1);
  try {
    // Success: status and elapsed on the headline, only output below it.
    const args = { command: "sleep 1.1; printf ready", purpose: "Wait for the service", yield_ms: 5000 };
    const ok = await bash.execute("ok", args, undefined, undefined, ctx);
    assert.equal(ok.details.status, "completed");
    assert(ok.details.durationMs >= 1000);
    const success = rows(card("ok", args, ok));
    assert.equal(success[0], "• Ran command · Wait for the service · ✓ in 1s", success.join("\n"));
    assert.equal(success.at(-1)!.trim(), "└ ready");
    assert(!success.join("\n").includes("Job:"), "a clean finish needs no job ID");

    // Failure: an error result that keeps its details.
    const failArgs = { command: "echo boom; exit 7", yield_ms: 5000 };
    const failed = await bash.execute("fail", failArgs, undefined, undefined, ctx);
    assert.equal(failed.isError, true);
    const failure = rows(card("fail", failArgs, failed));
    assert(failure[0]!.startsWith("• Command failed · ✗ exit 7"), failure[0]);
    assert(failure.some((row) => row.includes(`Job: ${failed.details.id}`)) && failure.some((row) => row.includes("boom")));

    // Yielded job: running status, actionable ID, hint only when expanded.
    const yieldArgs = { command: "cat", yield_ms: 0, stdin: true };
    const yielded = await bash.execute("yield", yieldArgs, undefined, undefined, ctx);
    assert(yielded.content[0].text.includes("Still running — job_wait"));
    const running = card("yield", yieldArgs, yielded);
    const collapsed = rows(running);
    assert.equal(collapsed[0], "• Ran command · running");
    assert(collapsed.some((row) => row.includes(`Job: ${yielded.details.id}`)));
    assert(!collapsed.join("\n").includes("Still running") && !collapsed.join("\n").includes("cursor:"));
    running.setExpanded(true);
    assert(rows(running).join("\n").includes("Still running — job_wait"));
    await tools.get("job_stop").execute("stop", { id: yielded.details.id });

    // Streaming partials: live elapsed from the job's start time.
    const partial = { content: [{ type: "text", text: "5s elapsed · ● Shell command · running · 5s\nJob: p1 · cursor: 0\n\nworking" }],
      details: { managed: true, id: "p1", status: "running", exitCode: null, startedAt: Date.now() - 5_000 } };
    const streaming = card("partial", { command: "sleep 9" }, partial, true);
    assert.equal(rows(streaming)[0], "• Running command · 5s");
    for (const width of [1, 20, 40, 80]) assert(streaming.render(width).every((row) => visibleWidth(row) <= width));
  } finally { await fire("session_shutdown"); }
  console.log("managed bash cards verified");
} finally { await rm(root, { recursive: true, force: true }); }
