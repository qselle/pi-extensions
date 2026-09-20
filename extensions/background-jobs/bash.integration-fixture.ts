import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = await mkdtemp(join(tmpdir(), "pi-managed-bash-"));
process.env.PI_CODING_AGENT_DIR = root;
const { default: background } = await import("./index.ts");
const { default: renderer } = await import("../tool-render/index.ts");
try {
  await writeFile(join(root, "cwd-marker"), "correct-directory");
  for (const order of [[background, renderer], [renderer, background]]) {
    const bus = new EventEmitter();
    const registered = order.map(() => new Map<string, any>());
    const handlers = new Map<string, Function[]>();
    const entries: any[] = [];
    for (const [index, extension] of order.entries()) extension({
      registerTool: (tool: any) => registered[index]!.set(tool.name, tool),
      registerCommand() {}, getThinkingLevel: () => "high",
      appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
      events: { emit: (name: string, data: unknown) => bus.emit(name, data), on: (name: string, handler: any) => { bus.on(name, handler); return () => bus.off(name, handler); } },
      on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    } as never);
    // Match Pi's actual first-extension-wins registry, not last-register-wins.
    const tool = (name: string) => registered.map((tools) => tools.get(name)).find(Boolean);
    const ctx = { mode: "json", cwd: root, sessionManager: { getSessionId: () => "fixture", getSessionFile: () => undefined, getBranch: () => entries }, ui: { notify() {} } };
    const fire = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
    await fire("session_start");
    try {
      const bash = tool("bash");
      assert.deepEqual(bash.constrainedSampling, { type: "json_schema", strict: "prefer" });
      for (const name of ["read", "write", "edit"]) assert.deepEqual(tool(name).constrainedSampling, { type: "json_schema", strict: "prefer" });
      assert(bash.parameters.properties.yield_ms, "managed schema must win in either order");
      assert.equal(bash.renderShell, "self", "renderer must be preserved");
      const result = await bash.execute("cwd", { command: "cat cwd-marker", yield_ms: 3000 }, undefined, undefined, ctx);
      assert(result.content[0].text.includes("correct-directory"));
      const updates: string[] = [];
      const streamed = await bash.execute("stream", { command: "printf ready; sleep 0.35; printf done", yield_ms: 3000 }, undefined, (value: any) => updates.push(value.content[0].text), ctx);
      assert(updates.some(text => text.includes("ready") && !text.includes("done")), "foreground output must arrive before command completion");
      assert(streamed.content[0].text.includes("readydone"));
      const count = updates.length;
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(updates.length, count, "partial updates must stop after the tool resolves");
      await assert.rejects(bash.execute("fail", { command: "echo failed-command; exit 7", yield_ms: 3000 }, undefined, undefined, ctx), /failed-command/);
      const running = await bash.execute("yield", { command: "cat", yield_ms: 0 }, undefined, undefined, ctx);
      assert(["starting", "running"].includes(running.details.status));
      const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
      let invalidations = 0;
      const context = { state: {}, args: { command: "cat" }, invalidate: () => invalidations++, cwd: root };
      const options = { expanded: false, isPartial: false };
      bash.renderResult(running, options, theme, context).render(80);
      await tool("job_write").execute("write", { id: running.details.id, text: Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n"), eof: true });
      await tool("job_wait").execute("wait", { id: running.details.id, wait_ms: 3000 });
      assert.equal(invalidations, 1);
      for (const width of [1, 20, 80]) {
        const rendered = bash.renderResult(running, options, theme, context).render(width);
        assert(rendered.every((line: string) => visibleWidth(line) <= width));
        if (width === 80) {
          const text = rendered.join("\n");
          assert(text.includes("completed") && text.includes(running.details.id), text);
          assert(text.includes("line-29") && text.includes("lines"), text);
        }
      }
      await fire("session_start");
      assert(tool("bash").parameters.properties.yield_ms, "session rebinding must not restore native execution");
    } finally { await fire("session_shutdown"); }
  }
  console.log("managed bash and renderer compose in both load orders");
} finally { await rm(root, { recursive: true, force: true }); }
