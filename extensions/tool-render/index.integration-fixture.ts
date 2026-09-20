/**
 * Boots the real tool-render extension in its own process so the built-in tool
 * overrides are created by pi's real factories, and verifies they execute
 * against the session cwd rather than the cwd captured at load time.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the config file so the overrides register regardless of local settings.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-tool-render-agent-"));

const { default: toolRenderExtension } = await import("./index.ts");

const sessionDir = mkdtempSync(join(tmpdir(), "pi-tool-render-session-"));
writeFileSync(join(sessionDir, "marker-file.txt"), "hello\n");

interface Registration {
  name: string;
  definition: any;
}

const registered: Registration[] = [];
const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
const pi = {
  registerTool(definition: any) {
    registered.push({ name: definition.name, definition });
  },
  registerCommand() {},
  on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
    const existing = handlers.get(name);
    if (existing) existing.push(handler);
    else handlers.set(name, [handler]);
  },
} as never;

function fire(name: string, ctx: unknown, event: unknown = {}): void {
  for (const handler of handlers.get(name) ?? []) handler(event, ctx);
}

const EXPECTED = ["read", "write", "edit", "bash", "grep", "find", "ls"];

toolRenderExtension(pi);

// Bash waits until all executor owners have loaded. Other overrides are immediate.
const initialCount = EXPECTED.length - 1;
assert.deepEqual(registered.map((entry) => entry.name), EXPECTED.filter((name) => name !== "bash"));

// session_start rebinds every override to the authoritative session cwd.
fire("session_start", { cwd: sessionDir, mode: "tui" });
const rebound = registered.slice(initialCount);
assert.deepEqual(rebound.map((entry) => entry.name), EXPECTED);

// Rendering overrides survive the rebinding.
for (const entry of rebound) {
  assert.equal(entry.definition.renderShell, "self");
  assert.equal(typeof entry.definition.renderCall, "function");
  assert.equal(typeof entry.definition.renderResult, "function");
}

// The rebound ls override resolves a relative path against the session cwd.
const ls = rebound.find((entry) => entry.name === "ls");
assert(ls, "expected an ls override");
const listing = await ls.definition.execute("call-1", {}, undefined, undefined, {});
const text = (listing.content ?? []).map((part: any) => part?.text ?? "").join("\n");
assert(text.includes("marker-file.txt"), `ls resolved the wrong cwd: ${text}`);

// A repeated session_start for the same cwd must not churn registrations.
fire("session_start", { cwd: sessionDir, mode: "tui" });
assert.equal(registered.length, initialCount + EXPECTED.length);

// A different cwd rebinds again.
const otherDir = mkdtempSync(join(tmpdir(), "pi-tool-render-other-"));
writeFileSync(join(otherDir, "other-marker.txt"), "hi\n");
fire("session_start", { cwd: otherDir, mode: "tui" });
assert.equal(registered.length, initialCount + EXPECTED.length * 2);
const otherLs = registered.slice(initialCount + EXPECTED.length).find((entry) => entry.name === "ls");
assert(otherLs, "expected a rebound ls override");
const otherListing = await otherLs.definition.execute("call-2", {}, undefined, undefined, {});
const otherText = (otherListing.content ?? []).map((part: any) => part?.text ?? "").join("\n");
assert(otherText.includes("other-marker.txt"), `ls did not follow the new cwd: ${otherText}`);

console.log("tool-render cwd binding verified");

const identity = (value: string) => value;
const theme = { fg: (_color: string, value: string) => value, bold: identity };
const read = registered.filter((entry) => entry.name === "read").at(-1)!.definition;
const error = { content: [{ type: "text", text: "Permission denied\nTry a readable path" }] };
const ctx = { toolCallId: "read-follower", args: { path: "secret.txt" }, cwd: otherDir, isError: true, invalidate() {} };
fire("tool_execution_start", {}, { toolName: "read", toolCallId: "read-leader", args: { path: "ok.txt" } });
fire("tool_execution_start", {}, { toolName: "read", toolCallId: ctx.toolCallId, args: ctx.args });
fire("tool_execution_end", {}, { toolName: "read", toolCallId: ctx.toolCallId, isError: true, result: error });
const collapsed = read.renderResult({}, {}, theme, { ...ctx, toolCallId: "read-leader", isError: false }).render(100).join("\n");
assert(collapsed.includes("failed: Permission denied"));
const expanded = read.renderResult(error, { expanded: true }, theme, ctx).render(100).join("\n");
assert(expanded.includes("Try a readable path"));
assert(expanded.includes("secret.txt"));
const dense = { content: [{ type: "text", text: Array.from({ length: 300 }, (_, index) => `line ${index}`).join("\n") }] };
const lines = read.renderResult(dense, { expanded: true }, theme, { ...ctx, isError: false }).render(50);
assert(lines.length <= 203);
assert(lines.join("\n").includes("line 299"));
assert(lines.join("\n").includes("+100 lines"));
const bash = registered.filter((entry) => entry.name === "bash").at(-1)!.definition;
const errorLines = bash.renderResult(error, {}, theme, { ...ctx, args: { command: "test" } }).render(100).join("\n");
assert(errorLines.includes("Permission denied"));
assert(errorLines.includes("Try a readable path"));
assert(bash.renderResult({}, {}, theme, ctx).render(100).join("\n").includes("failed"));
const command = "printf first-line\nprintf second-line-and-a-long-value";
const call = bash.renderCall({ command }, theme, { args: { command }, executionStarted: true, isPartial: true, expanded: true });
const rows = call.render(24);
assert(rows.join("\n").includes("first-line"));
assert(rows.join("").includes("second-line"));
assert(rows.length > 2, "long commands must wrap instead of collapsing to the first line");
const detail = "The operation failed because the requested source cannot be read. Check the final permission setting.";
const wrapped = read.renderResult({ content: [{ type: "text", text: detail }] }, {}, theme, ctx).render(30).join("\n");
assert(wrapped.includes("setting."), wrapped);
