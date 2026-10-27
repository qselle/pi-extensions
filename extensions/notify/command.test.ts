import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bannerMethod } from "./deliver.ts";
import notifyExtension from "./index.ts";

const previousDir = process.env.PI_CODING_AGENT_DIR;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pi-notify-")); process.env.PI_CODING_AGENT_DIR = dir; });
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
});

function load() {
  const delivered: string[] = [];
  const notices: { text: string; level: string }[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  let command: any;
  notifyExtension({
    registerCommand: (_name: string, options: unknown) => { command = options; },
    on: (name: string, handler: any) => handlers.set(name, handler),
    events: { on: () => () => {} },
  } as never, { deliver: (title, body) => delivered.push(`${title}: ${body}`) });
  const ctx = { cwd: "/work/project", mode: "json", sessionManager: { getSessionId: () => "s", getBranch: () => [] }, ui: { notify: (text: string, level: string) => notices.push({ text, level }), onTerminalInput: () => () => {} } };
  handlers.get("session_start")!({}, ctx);
  return { delivered, notices, run: (args: string) => command.handler(args, ctx), shutdown: () => handlers.get("session_shutdown")!({}, ctx) };
}

test("a delayed test follows the on/off gate; force bypasses it", async () => {
  const { delivered, notices, run } = load();
  await run("test 0");
  expect(notices.at(-1)!.text).toContain("Notification test in 0s");
  await Bun.sleep(5);
  expect(delivered).toEqual(["project: test: Notification test after 0s — click to focus this window."]);
  expect(notices.at(-1)!.text).toBe("Notification test sent.");

  writeFileSync(join(dir, "notify.json"), JSON.stringify({ enabled: false }));
  await run("off");
  await run("test 0");
  await Bun.sleep(5);
  expect(delivered).toHaveLength(1);
  expect(notices.at(-1)).toEqual({ text: "Notification test suppressed: notifications are off.", level: "warning" });

  await run("test force");
  expect(delivered).toHaveLength(2);
  expect(notices.at(-1)!.text).toContain("bypassing the on/off and focus checks");
});

test("invalid delays are rejected and shutdown cancels a pending test", async () => {
  const { delivered, notices, run, shutdown } = load();
  for (const value of ["-1", "61", "soon"]) {
    await run(`test ${value}`);
    expect(notices.at(-1)).toEqual({ text: "Usage: /notify test [0-60|force]", level: "warning" });
  }
  await run("test 0");
  shutdown();
  await Bun.sleep(5);
  expect(delivered).toEqual([]);
});

test("status includes delivery diagnostics", async () => {
  const { notices, run } = load();
  await run("");
  expect(notices.at(-1)!.text).toMatch(/now=would notify · focus=not tracked · focusReports=0 · banner=\S.* · bell=on · tmux=(yes|no) · goal=none/);
  expect(bannerMethod({ TERM_PROGRAM: "ghostty" }, "linux")).toBe("OSC 777");
  expect(bannerMethod({ TERM_PROGRAM: "iTerm.app" }, "darwin")).toBe("OSC 9");
  expect(bannerMethod({}, "darwin")).toBe("osascript");
  expect(bannerMethod({}, "win32")).toBe("none");
});
