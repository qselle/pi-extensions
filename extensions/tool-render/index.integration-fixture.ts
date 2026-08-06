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

// Overrides exist before any session event, bound to the process cwd.
assert.deepEqual(registered.map((entry) => entry.name), EXPECTED);

// session_start rebinds every override to the authoritative session cwd.
fire("session_start", { cwd: sessionDir, mode: "tui" });
const rebound = registered.slice(EXPECTED.length);
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
assert.equal(registered.length, EXPECTED.length * 2);

// A different cwd rebinds again.
const otherDir = mkdtempSync(join(tmpdir(), "pi-tool-render-other-"));
writeFileSync(join(otherDir, "other-marker.txt"), "hi\n");
fire("session_start", { cwd: otherDir, mode: "tui" });
assert.equal(registered.length, EXPECTED.length * 3);
const otherLs = registered.slice(EXPECTED.length * 2).find((entry) => entry.name === "ls");
assert(otherLs, "expected a rebound ls override");
const otherListing = await otherLs.definition.execute("call-2", {}, undefined, undefined, {});
const otherText = (otherListing.content ?? []).map((part: any) => part?.text ?? "").join("\n");
assert(otherText.includes("other-marker.txt"), `ls did not follow the new cwd: ${otherText}`);

console.log("tool-render cwd binding verified");
