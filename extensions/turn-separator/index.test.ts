import { expect, test } from "bun:test";
import turnSeparator, { SEPARATOR_STATE_ENTRY } from "./index.ts";
import { RESPONSE_TIMING_EVENT, TELEMETRY_CHANGED } from "../../lib/telemetry.ts";

function harness(enabled = false, now: () => number = () => 0) {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const events = new Map<string, (event: any) => void>();
  const appended: Array<{ type: string; data: any }> = [];
  const branch: any[] = [];
  const notices: string[] = [];
  let command: any;
  let renderer: any;
  const pi: any = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    events: { on: (name: string, handler: any) => { events.set(name, handler); return () => { events.delete(name); }; } },
    appendEntry(type: string, data: any) { appended.push({ type, data }); branch.push({ type: "custom", customType: type, data }); },
    registerEntryRenderer: (_name: string, fn: any) => { renderer = fn; },
    registerCommand: (_name: string, value: any) => { command = value; },
  };
  const ctx = { mode: "tui", sessionManager: { getBranch: () => branch, getSessionId: () => "a" }, ui: { notify: (text: string) => notices.push(text) } };
  turnSeparator(pi, now, enabled);
  const fire = (name: string, value: any = {}) => handlers.get(name)?.(value, ctx);
  fire("session_start");
  return {
    fire, branch, appended, notices, events,
    event: (name: string, value: any) => events.get(name)?.(value),
    command: (value: string) => command.handler(value, ctx),
    render: (data: any, width = 100) => renderer({ data }, { expanded: true }, { fg: (_: string, text: string) => text }).render(width),
    work: () => appended.filter((entry) => entry.type === "worked-for-separator"),
  };
}
const assistant = { message: { role: "assistant" } };

test("default is quiet, including old saved work-block receipts", () => {
  const h = harness();
  h.fire("message_start", assistant);
  h.fire("tool_execution_start");
  h.fire("message_start", assistant);
  expect(h.work()).toHaveLength(0);
  expect(h.render({ seconds: 74, stats: { input: 100, output: 20, cost: 0.5 } })).toEqual([]);
});

test("enabled rules use the whole step duration and one shared response timing sample", () => {
  let time = 0;
  const h = harness(true, () => time);
  h.fire("message_start", assistant);
  time = 3000;
  h.event(RESPONSE_TIMING_EVENT, { sessionId: "a", ttftMs: 480, tps: 42 });
  h.fire("tool_execution_start");
  h.fire("tool_execution_start");
  time = 74000;
  h.fire("turn_start");
  h.fire("message_start", assistant);
  expect(h.work()).toHaveLength(1);
  expect(h.work()[0].data).toEqual({ seconds: 74, timing: { ttftMs: 480, tps: 42 } });
  expect(h.render(h.work()[0].data).join("\n")).toContain("Worked for 1m 14s");
  h.fire("message_start", assistant);
  expect(h.work()).toHaveLength(1);
});

test("optional historical rules show timing without duplicating cost or usage", () => {
  const h = harness(true);
  const row = h.render({ seconds: 1, stats: { input: 100, output: 20, cost: 0.5, ttftMs: 480, tps: 42 } }).join("\n");
  expect(row).toContain("first token 480ms · 42 tokens/s");
  expect(row).not.toContain("Worked for");
  expect(row).not.toContain("in 100");
  expect(row).not.toContain("$");
});

test("only the current session's latest sample is used, including missing measurements", () => {
  const h = harness(true);
  h.fire("message_start", assistant);
  h.event(RESPONSE_TIMING_EVENT, { sessionId: "a", ttftMs: 20, tps: 100 });
  h.event(RESPONSE_TIMING_EVENT, { sessionId: "other", ttftMs: 1, tps: 999 });
  h.fire("tool_execution_start");
  h.fire("message_start", assistant);
  expect(h.work()[0].data.timing).toEqual({ ttftMs: 20, tps: 100 });
  h.event(RESPONSE_TIMING_EVENT, { sessionId: "a", ttftMs: 20, tps: 100 });
  h.event(RESPONSE_TIMING_EVENT, { sessionId: "a" });
  h.fire("tool_execution_start");
  h.fire("message_start", assistant);
  expect(h.work()[1].data.timing).toEqual({ ttftMs: undefined, tps: undefined });
});

test("on/off settings survive reload and follow the selected branch", async () => {
  const h = harness();
  await h.command("on");
  expect(h.appended.at(-1)).toEqual({ type: SEPARATOR_STATE_ENTRY, data: { version: 1, enabled: true } });
  h.fire("session_start");
  expect(h.render({ seconds: 74 })).toHaveLength(1);
  h.branch.splice(0);
  h.fire("session_tree");
  expect(h.render({ seconds: 74 })).toEqual([]);
  await h.command("toggle");
  expect(h.render({ seconds: 74 })).toHaveLength(1);
  await h.command("off");
  h.fire("session_start");
  expect(h.render({ seconds: 74 })).toEqual([]);
  const entries = h.appended.length;
  await h.command("status");
  await h.command("bad");
  expect(h.appended).toHaveLength(entries);
  expect(h.notices.at(-2)).toContain("Step timing: off");
});

for (const boundary of ["agent_settled", "session_start", "session_shutdown", "session_tree"]) {
  test(`${boundary} clears pending work and measurements`, () => {
    const h = harness(true);
    h.fire("message_start", assistant);
    h.event(RESPONSE_TIMING_EVENT, { sessionId: "a", ttftMs: 20, tps: 100 });
    h.fire("tool_execution_start");
    h.fire(boundary);
    h.fire("message_start", assistant);
    expect(h.work()).toHaveLength(0);
    h.fire("tool_execution_start");
    h.fire("message_start", { message: { role: "toolResult" } });
    h.fire("message_start", assistant);
    expect(h.work()[0].data.timing).toBeUndefined();
  });
}

test("hiding transcript telemetry also hides opted-in step rules", () => {
  const h = harness(true);
  h.event(TELEMETRY_CHANGED, { sessionId: "a", style: "hide" });
  expect(h.render({ seconds: 74 })).toEqual([]);
  h.event(TELEMETRY_CHANGED, { sessionId: "a", style: "compact" });
  expect(h.render({ seconds: 74 })).toHaveLength(1);
});

test("shutdown releases timing and style subscriptions on Pi's shared event bus", () => {
  const h = harness(true);
  expect(h.events.size).toBe(2);
  h.fire("session_shutdown", { reason: "reload" });
  expect(h.events.size).toBe(0);
});
