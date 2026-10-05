import { afterEach, expect, test } from "bun:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import extension, { FOREGROUND_GUIDELINE, PI_ENV_GUIDELINE } from "./index.ts";
import { JobService, MAX_WAIT_MS } from "./service.ts";
import { DEFAULT_OUTPUT_CHARS, DEFAULT_YIELD_MS } from "./arguments.ts";

const plain = { fg: (_color: string, text: string) => text };
const shutdowns: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of shutdowns.splice(0)) await stop(); });

async function session(mode = "json") {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function>();
  const entries: unknown[] = [];
  extension({
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, getThinkingLevel: () => "off",
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    events: { emit() {}, on() { return () => {}; } }, on: (name: string, handler: Function) => handlers.set(name, handler),
  } as never);
  const ctx = { mode, cwd: process.cwd(), sessionManager: { getSessionId: () => "tools-test", getSessionFile: () => undefined, getBranch: () => entries }, ui: { notify() {} } };
  await handlers.get("session_start")!({}, ctx);
  shutdowns.push(async () => { await handlers.get("session_shutdown")!({}, ctx); });
  const run = (name: string, args: Record<string, unknown>): Promise<any> => tools.get(name).execute("call", args, undefined, undefined, ctx);
  return { tools, run };
}
const outputOf = (value: any): string => value.content[0].text.slice(value.content[0].text.indexOf("\n\n") + 2);

test("finished output is tail-first with a marker pointing back to the start", async () => {
  const { run } = await session();
  const value = await run("bash", { command: "seq 1 20000", yield_ms: 5000 });
  expect(value.details.status).toBe("completed");
  const output = outputOf(value);
  expect(output.trimEnd().endsWith("\n20000")).toBe(true);
  const marker = output.match(/^\[earlier output omitted \((\d+) chars\); use cursor (\d+) to read from the start\]\n/);
  expect(marker).not.toBeNull();
  const body = output.slice(marker![0].length);
  expect(body.length).toBeLessThanOrEqual(DEFAULT_OUTPUT_CHARS);
  expect(Number(marker![1]) + body.length).toBe(value.details.cursor);
  expect(value.details.omitted).toBe(Number(marker![1]));
  const start = await run("job_output", { id: value.details.id, cursor: Number(marker![2]), max_chars: 1000 });
  expect(outputOf(start).startsWith("1\n2\n3\n")).toBe(true);
  expect(outputOf(start).length).toBeLessThanOrEqual(1000);
  expect(start.details.more).toBe(true);
});

test("output budgets are respected and marked", async () => {
  const { run, tools } = await session();
  const value = await run("bash", { command: "seq 1 20000", yield_ms: 5000, max_chars: 300 });
  const output = outputOf(value);
  expect(output).toContain("[earlier output omitted");
  expect(output.slice(output.indexOf("]\n") + 2).length).toBeLessThanOrEqual(300);
  const huge = await run("job_output", { id: value.details.id, cursor: 0, max_chars: 10_000_000 });
  expect(outputOf(huge).length).toBe(50_000);
  const bash = tools.get("bash");
  const tokens = await run("bash", bash.prepareArguments({ command: "seq 1 5000", yield_ms: 5000, max_output_tokens: 100 }));
  const tail = outputOf(tokens);
  expect(tail.slice(tail.indexOf("]\n") + 2).length).toBeLessThanOrEqual(400);
});

test("an omitted cursor continues from the last agent read without repeating output", async () => {
  const { run } = await session();
  const started = await run("bash", { command: "cat", stdin: true, yield_ms: 0 });
  const id = started.details.id;
  const reads: string[] = [outputOf(started).replace("No new output.", "")];
  await run("job_write", { id, text: "one\n" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const first = await run("job_wait", { id, wait_ms: 0 });
  reads.push(outputOf(first).replace("No new output.", ""));
  await run("job_write", { id, text: "two\n", eof: true });
  const second = await run("job_wait", { id });
  expect(second.details.status).toBe("completed");
  reads.push(outputOf(second).replace("No new output.", ""));
  const third = await run("job_wait", { id });
  expect(outputOf(third)).toBe("No new output.");
  expect(reads.join("")).toBe("one\ntwo\n");
  // Explicit cursors still page from any retained offset.
  expect(outputOf(await run("job_output", { id, cursor: 0 }))).toBe("one\ntwo\n");
});

test("bash yields after ten seconds by default and one job_wait covers five minutes", async () => {
  const waits: number[] = [];
  const original = JobService.prototype.wait;
  JobService.prototype.wait = function (id, milliseconds, signal) { waits.push(milliseconds ?? -1); return original.call(this, id, milliseconds, signal); };
  try {
    const { run, tools } = await session();
    expect((await run("bash", { command: "true" })).details.status).toBe("completed");
    expect(waits.at(-1)).toBe(DEFAULT_YIELD_MS);
    const yielded = await run("bash", { command: "sleep 1; echo finished", yield_ms: 100 });
    expect(yielded.details.status).toBe("running");
    const done = await run("job_wait", { id: yielded.details.id });
    expect(waits.at(-1)).toBe(MAX_WAIT_MS);
    expect(done.details.status).toBe("completed");
    expect(outputOf(done)).toContain("finished");
    // Values above the caps validate and clamp instead of failing the call.
    const wait = tools.get("job_wait");
    const args = { id: yielded.details.id, wait_ms: 10_000_000 };
    expect(validateToolArguments(wait, { type: "toolCall", id: "wait", name: "job_wait", arguments: args })).toEqual(args);
    await run("job_wait", args);
    expect(waits.at(-1)).toBe(MAX_WAIT_MS);
    await run("bash", { command: "true", yield_ms: 999_999 });
    expect(waits.at(-1)).toBe(30_000);
    expect(DEFAULT_YIELD_MS + MAX_WAIT_MS).toBeGreaterThanOrEqual(180_000);
  } finally { JobService.prototype.wait = original; }
});

test("bash keeps the PI_* guideline and yielded results say how to follow up", async () => {
  const { run, tools } = await session();
  expect(tools.get("bash").promptGuidelines).toContain(PI_ENV_GUIDELINE);
  expect(tools.get("bash").promptGuidelines).toContain(FOREGROUND_GUIDELINE);
  const value = await run("bash", { command: "sleep 5", yield_ms: 0 });
  expect(value.content[0].text).toContain(`Still running — job_wait id=${value.details.id}`);
  const stopped = await run("job_stop", { id: value.details.id });
  expect(stopped.content[0].text).not.toContain("Still running");
});

test("job names default to the purpose, then the command head", async () => {
  const { run } = await session("tui");
  const card = ((globalThis as any)[Symbol.for("@qselle/pi-extensions.overlay-stack.v1")].cards.get("background-jobs")).definition;
  const purposeful = await run("bash", { command: "sleep 5", purpose: "Wait for the fixture server", yield_ms: 0 });
  const bare = await run("bash", { command: "sleep  6\n# trailing", yield_ms: 0 });
  const rows = card.renderBody(60, 5, plain).join("\n");
  expect(rows).toContain(" Wait for the fixture server");
  expect(rows).toContain(" sleep 6 # trailing");
  expect(rows).not.toContain("Shell command");
  await run("job_stop", { id: purposeful.details.id });
  await run("job_stop", { id: bare.details.id });
});

test("argument aliases from other shell tool sets validate", async () => {
  const { tools } = await session();
  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["job_wait", { job_id: "abc", waitMs: 5000, max_output_tokens: 100, cursor: 3 }, { id: "abc", wait_ms: 5000, max_chars: 400, cursor: 3 }],
    ["job_output", { job_id: "abc", wait: true }, { id: "abc", wait_ms: MAX_WAIT_MS }],
    ["bash", { command: "ls", "yield-time_ms": 2000, max_output_tokens: 1000, reasoning: "List files", tty: false }, { command: "ls", yield_ms: 2000, max_chars: 4000, purpose: "List files", pty: false }],
    ["job_start", { name: "Server", command: "true", timeout: 5 }, { name: "Server", command: "true", timeout_seconds: 5 }],
    ["job_write", { job_id: "abc", chars: "x", close_stdin: true }, { id: "abc", text: "x", eof: true }],
    ["job_stop", { job_id: "abc" }, { id: "abc" }],
  ];
  for (const [name, raw, expected] of cases) {
    const tool = tools.get(name);
    const prepared = tool.prepareArguments(raw);
    expect(prepared).toEqual(expected);
    expect(validateToolArguments(tool, { type: "toolCall", id: name, name, arguments: prepared })).toEqual(expected);
  }
  expect(tools.get("job_wait").prepareArguments({ id: "kept", job_id: "ignored" })).toEqual({ id: "kept" });
  const canonical = { id: "abc" };
  expect(tools.get("job_stop").prepareArguments(canonical)).toBe(canonical);
});

test("managed results carry exit, signal, status and timing details", async () => {
  const { run } = await session();
  const done = await run("bash", { command: "printf ok", yield_ms: 5000 });
  expect(done.details).toMatchObject({ managed: true, status: "completed", exitCode: 0, signal: null });
  expect(done.details.endedAt).toBeGreaterThanOrEqual(done.details.startedAt);
  expect(done.details.durationMs).toBe(done.details.endedAt - done.details.startedAt);
  const failed = await run("bash", { command: "exit 3", yield_ms: 5000 });
  expect(failed.isError).toBe(true);
  expect(failed.details).toMatchObject({ status: "failed", exitCode: 3 });
  const running = await run("bash", { command: "sleep 5", yield_ms: 0 });
  expect(running.details.endedAt).toBeUndefined();
  expect(running.details.durationMs).toBeGreaterThanOrEqual(0);
  const stopped = await run("job_wait", { id: (await run("job_stop", { id: running.details.id })).details.id, wait_ms: 5000 });
  expect(stopped.details).toMatchObject({ status: "stopped", signal: "SIGTERM" });
  expect(typeof stopped.details.endedAt).toBe("number");
});
