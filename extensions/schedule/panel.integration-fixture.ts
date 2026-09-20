import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { SchedulePanel, scheduleBlocks } from "./panel.ts";
import { createReminder, pauseTask } from "./schedule.ts";
initTheme("dark", false);
const handlers = new Map<string, Function>();
const events: any[] = [];
const panel = new SchedulePanel({ on: (name: string, handler: Function) => handlers.set(name, handler), events: { emit: (_: string, value: unknown) => events.push(value) } } as never);
const prompt = "Long reminder ".repeat(30) + "unique-search-target";
const task = pauseTask(createReminder({ prompt, runAt: Date.now() + 60000 }), "Interrupted turn");
assert(scheduleBlocks([task], true)[1]!.body.includes(prompt));
assert(scheduleBlocks([task], true)[1]!.body.includes("Interrupted turn"));
assert(scheduleBlocks([], false)[0]!.body.includes("No scheduled tasks"));
const notices: string[] = [];
await panel.open({ mode: "rpc", ui: { notify: (text: string) => notices.push(text) } } as never, [task], false);
assert(notices[0]!.includes(prompt));
for (const event of ["session_start", "session_tree", "session_shutdown"]) {
  let closed = 0;
  await panel.open({ mode: "tui", ui: { custom: async (factory: Function) => {
    const view = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s }, { matches: () => false, getKeys: () => [] }, () => closed++);
    assert(view.render(80).join("\n").includes("Schedule queue"), "Snapshot opens at its overview, not the bottom of the last prompt");
    for (const width of [1, 20, 80]) assert(view.render(width).every((line: string) => visibleWidth(line) <= width));
    view.handleInput("/");
    for (const char of "unique-search-target") view.handleInput(char);
    assert(view.render(80).join("\n").includes("unique-search-target"));
    handlers.get(event)!();
  } } } as never, [task], true);
  assert.equal(closed, 1);
  assert.equal(events.at(-1).open, false);
}
console.log("schedule panel verified");
