import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { JobService, type StartJob } from "./service.ts";
import { registerSecretVault, SecretVault } from "../questions/secrets.ts";
import { COMMAND_PURPOSE_GUIDELINE } from "../../lib/tool-purpose.ts";

const root = await mkdtemp(join(tmpdir(), "pi-managed-bash-"));
process.env.PI_CODING_AGENT_DIR = root;
const { default: background } = await import("./index.ts");
const { default: renderer } = await import("../tool-render/index.ts");
initTheme("dark", false);
const vault = new SecretVault();
const secret = "purpose-fixture-private-value";
vault.issue("purpose", secret);
const unregisterSecrets = registerSecretVault(vault);
const launches: StartJob[] = [];
const originalStart = JobService.prototype.start;
JobService.prototype.start = function (input, signal) { launches.push(input); return originalStart.call(this, input, signal); };
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
      assert.equal(bash.parameters.properties.purpose.type, "string");
      assert(!bash.parameters.required.includes("purpose"), "purpose must remain optional for old calls");
      assert.equal(bash.parameters.properties.purpose.maxLength, undefined, "display metadata must not reject a long explanation");
      assert(bash.promptGuidelines.includes(COMMAND_PURPOSE_GUIDELINE));
      assert.equal(bash.renderShell, "self", "renderer must be preserved");
      const argumentsWithPurpose = { command: "cat cwd-marker", yield_ms: 3000, purpose: "Inspect the active session directory", name: "Directory check", timeout: 2 };
      const before = launches.length;
      const result = await bash.execute("cwd", argumentsWithPurpose, undefined, undefined, ctx);
      assert(result.content[0].text.includes("correct-directory"));
      assert.equal(launches.length, before + 1, "purpose must not cause an extra command execution");
      assert.equal(launches.at(-1)!.command, argumentsWithPurpose.command);
      assert.equal(launches.at(-1)!.name, "Directory check");
      assert.equal(launches.at(-1)!.timeoutMs, 2000);
      assert(!Object.hasOwn(launches.at(-1)!, "purpose"), "purpose must not reach the process executor");
      assert.equal(argumentsWithPurpose.purpose, "Inspect the active session directory", "execution must not mutate tool arguments");
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
      const shell = 'if true; then printf "%s\\n" "$PWD"; fi';
      const shellRows = bash.renderCall({ command: shell }, theme, { args: { command: shell } }).render(100);
      assert.deepEqual(shellRows.map((row: string) => stripVTControlCharacters(row).trimEnd()), ["• Ran command", `  │ ${shell}`]);
      assert(new Set(shellRows.join("\n").match(/\x1b\[38;[^m]+m/g)).size >= 3, "managed commands must retain shell syntax colors in both load orders");
      const purposeArgs = { command: shell, purpose: `Check \x1b[31m${secret.slice(0, 10)}\u202e${secret.slice(10)}\x1b[0m\nconfiguration\u202e` };
      const purposeRows = stripVTControlCharacters(bash.renderCall(purposeArgs, theme, { args: purposeArgs }).render(100).join("\n"));
      assert(purposeRows.includes("Check [redacted] configuration"), purposeRows);
      assert(!purposeRows.includes(secret) && !purposeRows.includes("\u202e"));
      assert(purposeRows.includes(shell), "purpose must not replace or rewrite the source panel");
      assert.equal(purposeArgs.command, shell);
      assert(purposeArgs.purpose.includes("\u202e"), "rendering must not mutate persisted arguments");
      const atLimit = { command: shell, purpose: "x".repeat(150) + secret };
      const cappedRows = stripVTControlCharacters(bash.renderCall(atLimit, theme, { args: atLimit, expanded: true }).render(200).join("\n"));
      assert(!cappedRows.includes(secret.slice(0, 10)), "redact before capping to avoid exposing a partial secret");
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
  const standaloneTools = new Map<string, any>();
  const standaloneHandlers = new Map<string, Function>();
  background({ registerTool: (tool: any) => standaloneTools.set(tool.name, tool), registerCommand() {},
    on: (name: string, handler: Function) => standaloneHandlers.set(name, handler),
    events: { emit() {}, on() { return () => {}; } },
  } as never);
  try {
    const bash = standaloneTools.get("bash");
    assert(bash.parameters.properties.purpose && !bash.parameters.required.includes("purpose"));
    const theme = { fg: (_: string, text: string) => text };
    const args = { command: "printf ok", purpose: `Check ${secret}` };
    assert.deepEqual(bash.renderCall(args, theme, { args }).render(100), ["Check [redacted]", "$ printf ok"]);
    assert.deepEqual(bash.renderCall({ command: "printf ok" }, theme, {}).render(100), ["$ printf ok"]);
  } finally { await standaloneHandlers.get("session_shutdown")!({}, {}); }
  console.log("managed bash and renderer compose in both load orders");
} finally {
  JobService.prototype.start = originalStart;
  unregisterSecrets();
  await rm(root, { recursive: true, force: true });
}
