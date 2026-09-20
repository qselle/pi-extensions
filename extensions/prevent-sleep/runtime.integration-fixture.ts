import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import extension from "./index.ts";

assert.equal(process.platform, "darwin", "This fixture measures macOS sleep assertions only");
const execute = promisify(execFile);
const handlers = new Map<string, Function>();
const children: ChildProcess[] = [];
let command: any;
const notices: string[] = [];
const ctx = { ui: { notify: (text: string) => notices.push(text) } };
extension({ on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand: (_: string, value: any) => { command = value; } } as never, {
  spawn: ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args); children.push(child); return child;
  }) as typeof spawn,
});

async function holdsAssertion(pid: number): Promise<boolean> {
  const { stdout } = await execute("/usr/bin/pmset", ["-g", "assertions"], { timeout: 3000, maxBuffer: 1024 * 1024 });
  // Inspect only the helper owned by this test; do not log unrelated applications.
  return stdout.split("\n").some((line) => line.includes(`pid ${pid}(caffeinate)`) && line.includes("PreventUserIdleSystemSleep"));
}
async function waitFor(test: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await test())) {
    assert(Date.now() < deadline, message);
    await Bun.sleep(50);
  }
}

try {
  for (const boundary of ["agent_settled", "off", "session_start", "session_shutdown"]) {
    handlers.get("session_start")!();
    await command.handler("on", ctx);
    const before = children.length;
    handlers.get("agent_start")!();
    const child = children.at(-1)!;
    assert.equal(children.length, before + 1);
    assert(child.pid);
    await waitFor(() => holdsAssertion(child.pid!), "The test helper did not acquire an idle-sleep assertion");
    handlers.get("agent_start")!();
    assert.equal(children.length, before + 1, "Repeated start must keep a single helper");
    await command.handler("", ctx);
    assert(notices.at(-1)!.includes("running for the active agent"));
    if (boundary === "off") await command.handler("off", ctx);
    else handlers.get(boundary)!();
    await waitFor(async () => child.exitCode !== null || child.signalCode !== null, "The helper did not exit");
    await waitFor(async () => !(await holdsAssertion(child.pid!)), "The assertion remained after release");
  }
  const count = children.length;
  handlers.get("agent_start")!();
  assert.equal(children.length, count, "A late start after shutdown must not launch a helper");
} finally {
  handlers.get("session_shutdown")!();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
console.log("macOS idle-sleep assertion acquisition and release verified");
