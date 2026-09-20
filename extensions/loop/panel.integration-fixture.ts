import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "./index.ts";
import { createLoop, pauseLoop } from "./loop.ts";

const root = mkdtempSync(join(tmpdir(), "pi-loop-panel-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(agentDir);
mkdirSync(join(root, ".pi"));
writeFileSync(join(agentDir, "loop.md"), "User default source");
writeFileSync(join(root, ".pi/loop.md"), "Project default version one");
initTheme("dark", false);
const handlers = new Map<string, Function[]>();
const commands = new Map<string, any>();
const modalEvents: { open: boolean }[] = [];
const notices: string[] = [];
let writes = 0, wakes = 0, trusted = true;
const now = Date.now();
const prompt = "Long literal instruction `command`\n".repeat(80) + "unique-tail-target";
const jobs = [
  { ...createLoop(prompt, 300_000, now, "fixed"), nextRunAt: now + 300_000 },
  pauseLoop(createLoop("default at creation", null, now, "default", "default"), "Paused for inspection"),
];
let entries: unknown[] = [{ type: "custom", customType: "loop-state", data: { version: 2, jobs } }];
const pi = {
  on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
  events: { emit(_name: string, value: { open: boolean }) { modalEvents.push(value); } },
  registerCommand(name: string, command: unknown) { commands.set(name, command); },
  registerTool() {}, appendEntry() { writes++; }, sendMessage() { wakes++; },
};
const ctx = {
  cwd: root, mode: "rpc", isIdle: () => false, hasPendingMessages: () => false,
  isProjectTrusted: () => trusted, getContextUsage: () => ({ percent: 10 }),
  sessionManager: { getBranch: () => entries },
  ui: { notify: (text: string) => notices.push(text), setStatus() {} },
};
async function fire(name: string) { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); }
extension(pi as never);
try {
  await fire("session_start");
  const command = commands.get("loop");
  assert(command.getArgumentCompletions("v").some((item: { value: string }) => item.value === "view"));
  const inspect = () => command.handler("view", ctx);
  await inspect();
  assert(notices.at(-1)!.includes(prompt));
  assert(notices.at(-1)!.includes("Project default version one"));
  writeFileSync(join(root, ".pi/loop.md"), "Project default version two");
  await inspect();
  assert(notices.at(-1)!.includes("Project default version two"));
  assert(!notices.at(-1)!.includes("version one"));
  trusted = false;
  await fire("session_tree");
  await inspect();
  assert(notices.at(-1)!.includes("User default source"));
  assert(!notices.at(-1)!.includes("Project default"));
  assert.equal(writes, 0, "Inspection must not append state or reschedule work");
  assert.equal(wakes, 0);
  await command.handler("status", ctx);
  assert(!notices.at(-1)!.includes("unique-tail-target"), "The existing status remains compact");
  for (const boundary of ["session_start", "session_tree", "session_shutdown"]) {
    let closed = 0;
    await command.handler("view", { ...ctx, mode: "tui", ui: { ...ctx.ui, custom: async (factory: Function) => {
      const view = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, {
        fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text,
      }, { matches: () => false, getKeys: () => [] }, () => closed++);
      assert(view.render(80).join("\n").includes("Session loops"));
      assert(!view.render(160).join("\n").includes("t thinking"));
      for (const width of [1, 20, 40, 80]) assert(view.render(width).every((line: string) => visibleWidth(line) <= width));
      view.handleInput("/");
      for (const char of "unique-tail-target") view.handleInput(char);
      assert(view.render(80).join("\n").includes("unique-tail-target"));
      const beforeWrites = writes;
      assert.equal(wakes, 0);
      await fire(boundary);
      if (boundary !== "session_shutdown") assert.equal(writes, beforeWrites);
    } } });
    assert.equal(closed, 1);
    assert.equal(modalEvents.at(-1)!.open, false);
  }
  entries = [];
  await fire("session_start");
  await inspect();
  assert(notices.at(-1)!.includes("No loops are scheduled"));
  assert.equal(wakes, 0);
} finally {
  await fire("session_shutdown");
  rmSync(root, { recursive: true, force: true });
}
console.log("loop inspection and lifecycle verified");
