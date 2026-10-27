import { afterEach, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import extension, { BASH_OUTPUT_SCHEMA, FOREGROUND_GUIDELINE, NOTICE_TYPE, PI_ENV_GUIDELINE } from "./index.ts";
import { JobService, MAX_WAIT_MS } from "./service.ts";
import { DEFAULT_OUTPUT_CHARS, DEFAULT_YIELD_MS } from "./arguments.ts";
import { COLLAPSED_TAIL_ROWS } from "./render.ts";
import { encodeJob, JOB_HISTORY_ENTRY } from "./history.ts";

initTheme("dark");
const plain = { fg: (_color: string, text: string) => text };
const shutdowns: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of shutdowns.splice(0)) await stop(); });

async function session(mode = "json", extra: Record<string, unknown> = {}, seed: unknown[] = []) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const entries: unknown[] = [...seed];
  const messages: { message: any; options: any }[] = [];
  const renderers = new Map<string, any>();
  extension({
    sendMessage: (message: any, options: any) => messages.push({ message, options }), registerMessageRenderer: (type: string, renderer: any) => renderers.set(type, renderer),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), getThinkingLevel: () => "off",
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    events: { emit() {}, on() { return () => {}; } }, on: (name: string, handler: Function) => handlers.set(name, handler),
  } as never);
  const ctx = { mode, cwd: process.cwd(), sessionManager: { getSessionId: () => "tools-test", getSessionFile: () => undefined, getBranch: () => entries }, ui: { notify() {} },
    isIdle: () => true, hasPendingMessages: () => false, ...extra };
  await handlers.get("session_start")!({}, ctx);
  shutdowns.push(async () => { await handlers.get("session_shutdown")!({}, ctx); });
  const run = (name: string, args: Record<string, unknown>, signal?: AbortSignal, update?: (value: any) => void): Promise<any> => tools.get(name).execute("call", args, signal, update, ctx);
  return { tools, run, ctx, handlers, messages, renderers, commands };
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
  const unread = (value: any) => reads.push(outputOf(value).replace("No new output.", ""));
  // A write waits for the reply, so its result already carries the echoed line.
  const reply = await run("job_write", { id, text: "one\n" });
  expect(reply.details.wait.end).toBe("output");
  unread(reply);
  unread(await run("job_wait", { id, wait_ms: 0 }));
  unread(await run("job_write", { id, text: "two\n", eof: true, wait_ms: 0 }));
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
  const original = JobService.prototype.waitFor;
  JobService.prototype.waitFor = function (id, milliseconds, options) { waits.push(milliseconds); return original.call(this, id, milliseconds, options); };
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
  } finally { JobService.prototype.waitFor = original; }
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
    ["job_wait", { job_id: "abc", wait: true }, { id: "abc", wait_ms: MAX_WAIT_MS }],
    ["job_output", { job_id: "abc", wait: true }, { id: "abc", wait: true }],
    ["bash", { command: "ls", "yield-time_ms": 2000, max_output_tokens: 1000, reasoning: "List files", tty: false }, { command: "ls", yield_ms: 2000, max_chars: 4000, purpose: "List files", pty: false }],
    ["job_start", { name: "Server", command: "true", timeout: 5 }, { name: "Server", command: "true", timeout_seconds: 5 }],
    ["job_write", { job_id: "abc", chars: "x", close_stdin: true, "yield-time_ms": 100 }, { id: "abc", text: "x", eof: true, wait_ms: 100 }],
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

test("job cards render compactly without the default boxed shell", async () => {
  const { tools } = await session();
  const tail = Array.from({ length: 30 }, (_, index) => `line-${index}`).join("\n");
  const value = { content: [{ type: "text", text: `✓ build · completed · 1s · exit 0\nJob: abc · cursor: 200\n\n${tail}` }], details: { managed: true, status: "completed" }, isError: false };
  for (const name of ["job_wait", "job_output", "job_stop"]) {
    const tool = tools.get(name);
    expect(tool.renderShell).toBe("self");
    const card = new ToolExecutionComponent(name, `card-${name}`, { id: "abc", purpose: "Check the build" }, undefined, tool, { requestRender() {} } as never, process.cwd());
    card.setArgsComplete(); card.markExecutionStarted(); card.updateResult(value);
    const raw = card.render(100);
    expect(raw).toEqual(card.render(100));
    expect(raw.join("\n")).not.toContain("\x1b[48");
    const rows = raw.map((row) => stripVTControlCharacters(row));
    expect(rows.length).toBeLessThanOrEqual(3 + 1 + COLLAPSED_TAIL_ROWS);
    expect(rows[1]!.startsWith("• ")).toBe(true);
    expect(rows[1]).toContain("· Check the build");
    expect(rows[2]).toBe("  └ ✓ build · completed · 1s · exit 0");
    expect(rows.at(-1)).toBe("    line-29");
    card.setExpanded(true);
    expect(card.render(100).map((row) => stripVTControlCharacters(row))).toContain("    line-0");
  }
  const list = tools.get("job_list");
  const jobs = Array.from({ length: 9 }, (_, index) => ({ id: `job${index}`, name: `Job ${index}`, status: index ? "completed" : "running", icon: index ? "✓" : "●" }));
  const card = new ToolExecutionComponent("job_list", "list", {}, undefined, list, { requestRender() {} } as never, process.cwd());
  card.setArgsComplete(); card.markExecutionStarted(); card.updateResult({ content: [{ type: "text", text: "listing" }], details: { jobs }, isError: false });
  const rows = card.render(100).map((row) => stripVTControlCharacters(row));
  expect(rows[2]).toBe("  └ 9 jobs · 1 active");
  expect(rows.length).toBeLessThanOrEqual(3 + COLLAPSED_TAIL_ROWS + 1);
});

test("bash returns a structured result shaped like Pi's built-in bash", async () => {
  const { run, tools } = await session();
  expect(tools.get("bash").outputSchema).toBe(BASH_OUTPUT_SCHEMA);
  const failed = await run("bash", { command: "printf ok; exit 3", yield_ms: 5000 });
  expect(failed.isError).toBe(true);
  expect(failed.structuredContent).toMatchObject({ output: "ok", truncated: false, exit_code: 3, status: "failed" });
  expect(failed.structuredContent.job_id).toBeUndefined();
  expect(Value.Check(BASH_OUTPUT_SCHEMA, failed.structuredContent)).toBe(true);
  const running = await run("bash", { command: "printf start; sleep 5", yield_ms: 300 });
  expect(running.structuredContent).toMatchObject({ output: "start", status: "running", job_id: running.details.id });
  expect("exit_code" in running.structuredContent).toBe(false);
  expect(Value.Check(BASH_OUTPUT_SCHEMA, running.structuredContent)).toBe(true);
  await run("job_stop", { id: running.details.id });
  // The whole retained log, not the model's newest-first budget.
  const long = await run("bash", { command: "seq 1 20000", yield_ms: 5000, max_chars: 300 });
  expect(long.structuredContent.output.startsWith("1\n2\n")).toBe(true);
  expect(long.structuredContent.exit_code).toBe(0);
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

const abortAfter = (milliseconds: number) => { const controller = new AbortController(); setTimeout(() => controller.abort(), milliseconds); return controller.signal; };

test("an interrupted wait returns the output so far and says the job is still running", async () => {
  const { run, tools } = await session();
  const started = await run("bash", { command: "printf ready; sleep 5", yield_ms: 300 });
  const id = started.details.id;
  const waited = await run("job_wait", { id }, abortAfter(150));
  expect(waited.details.status).toBe("running");
  expect(waited.details.wait).toMatchObject({ limitMs: MAX_WAIT_MS, end: "interrupted" });
  expect(waited.content[0].text).toContain("The user interrupted this wait after 0s; the job is still running, so this does not mean it hung.");
  const card = tools.get("job_wait").renderResult(waited, { expanded: false, isPartial: false }, plain, { isError: false });
  expect(card.render(120)[0]).toContain(" · interrupted after 0s");
  expect(outputOf(await run("job_output", { id }))).toBe("No new output.");
  await run("job_stop", { id });
});

test("a queued user message ends a wait promptly", async () => {
  let queued = false;
  const { run } = await session("json", { hasPendingMessages: () => queued });
  const id = (await run("bash", { command: "sleep 5", yield_ms: 0 })).details.id;
  setTimeout(() => { queued = true; }, 100);
  const started = Date.now();
  const waited = await run("job_wait", { id });
  expect(Date.now() - started).toBeLessThan(800);
  expect(waited.details.wait.end).toBe("message");
  expect(waited.content[0].text).toContain("because a new user message is queued; the job is still running.");
  await run("job_stop", { id });
});

test("cancelling the initial bash wait stops the command", async () => {
  const { run } = await session();
  await expect(run("bash", { command: "sleep 5", yield_ms: 5000 }, abortAfter(150))).rejects.toThrow("Command cancelled; the job was stopped.");
  const jobs = (await run("job_list", {})).details.jobs;
  expect(["stopping", "stopped"]).toContain(jobs.at(-1).status);
});

test("waits stream output and labelled timers into the card, then freeze", async () => {
  const { run, tools } = await session();
  const id = (await run("bash", { command: "printf first; sleep 0.4; printf second; sleep 0.9", yield_ms: 0 })).details.id;
  const updates: any[] = [];
  const done = await run("job_wait", { id }, undefined, (value) => updates.push(value));
  expect(updates.length).toBeGreaterThanOrEqual(2);
  const last = updates.at(-1);
  expect(last.details.wait).toMatchObject({ limitMs: MAX_WAIT_MS });
  expect(last.details.wait.end).toBeUndefined();
  expect(last.content[0].text).toMatch(/^● .+ · [1-9]s \/ 5m · job running [1-9]s\n/);
  expect(last.content[0].text).not.toContain("Still running");
  expect(updates.some((value) => outputOf(value).includes("first") && !outputOf(value).includes("second"))).toBe(true);
  const live = tools.get("job_wait").renderResult(last, { expanded: false, isPartial: true }, plain, { isError: false }).render(120);
  expect(live[0]).toMatch(/[1-9]s \/ 5m · job running [1-9]s$/);
  // Progress never advances the agent's read position.
  expect(done.details.wait.end).toBe("exit");
  expect(outputOf(done)).toBe("firstsecond");
  const card = tools.get("job_wait").renderResult(done, { expanded: false, isPartial: false }, plain, { isError: false });
  expect(card.render(120)[0]).toMatch(/^  └ ✓ .+ · completed · \d+s · exit 0$/);
});

test("job_output waits return on the next output; wait=true waits for exit", async () => {
  const { run } = await session();
  const id = (await run("bash", { command: "sleep 0.3; printf tick; sleep 0.5; printf done", yield_ms: 0 })).details.id;
  const started = Date.now();
  const next = await run("job_output", { id, wait_ms: 5000 });
  expect(Date.now() - started).toBeLessThan(700);
  expect(next.details).toMatchObject({ status: "running", wait: { end: "output" } });
  expect(outputOf(next)).toBe("tick");
  const exit = await run("job_output", { id, wait: true });
  expect(exit.details).toMatchObject({ status: "completed", wait: { end: "exit", limitMs: MAX_WAIT_MS } });
  expect(outputOf(exit)).toBe("done");
});

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function until(check: () => boolean, limit = 3000) {
  const deadline = Date.now() + limit;
  while (!check()) { if (Date.now() > deadline) throw new Error("Condition did not become true"); await sleep(10); }
}

test("a job left running when the agent settles reports its completion with a turn", async () => {
  const { run, handlers, ctx, messages, renderers } = await session();
  const id = (await run("bash", { command: "sleep 0.3; printf finished-output; exit 4", yield_ms: 0 })).details.id;
  await handlers.get("agent_settled")!({}, ctx);
  await until(() => messages.length === 1);
  const { message, options } = messages[0]!;
  expect(options).toEqual({ triggerTurn: true });
  expect(message).toMatchObject({ customType: NOTICE_TYPE, display: true });
  expect(message.content).toStartWith("A background job finished after you last checked it.");
  expect(message.content).toContain("· failed ·");
  expect(message.content).toContain("exit 4");
  expect(message.content).toContain("finished-output");
  // The notice is the model's read: nothing is unread or reported twice.
  expect(outputOf(await run("job_output", { id }))).toBe("No new output.");
  const rows = renderers.get(NOTICE_TYPE)(message, { expanded: false, outputPad: 1 }, plain).render(100);
  expect(rows[0]).toMatch(/^• Finished job · /);
  expect(rows.join("\n")).toContain("finished-output");
  await handlers.get("agent_settled")!({}, ctx);
  await sleep(50);
  expect(messages).toHaveLength(1);
});

test("notices skip stopped, already-read and in-run jobs, and wait for an idle agent without queued messages", async () => {
  let idle = false;
  let queued = false;
  const { run, handlers, ctx, messages } = await session("json", { isIdle: () => idle, hasPendingMessages: () => queued });
  const start = async (command: string) => (await run("bash", { command, yield_ms: 0 })).details.id;
  const seen = await start("sleep 0.2");
  const stopped = await start("sleep 5");
  const later = await start("sleep 0.2; printf later");
  await handlers.get("agent_settled")!({}, ctx);
  const quick = await start("sleep 0.1");
  await run("job_wait", { id: seen });
  await run("job_stop", { id: stopped });
  await sleep(400);
  idle = true;
  queued = true;
  await handlers.get("agent_settled")!({}, ctx);
  await sleep(50);
  expect(messages).toHaveLength(0);
  queued = false;
  await handlers.get("agent_settled")!({}, ctx);
  await until(() => messages.length === 1);
  const content: string = messages[0]!.message.content;
  expect(content).toContain(`Job: ${later}`);
  for (const id of [seen, stopped, quick]) expect(content).not.toContain(id);
});

test("the overlay shows only yielded jobs under a running count", async () => {
  const { run } = await session("tui");
  const card = ((globalThis as any)[Symbol.for("@qselle/pi-extensions.overlay-stack.v1")].cards.get("background-jobs")).definition;
  const pending = run("bash", { command: "sleep 5", purpose: "Serve the fixture", yield_ms: 400 });
  await sleep(150);
  expect(card.visible()).toBe(false);
  const { details } = await pending;
  expect(card.visible()).toBe(true);
  expect(card.title({ ...plain, bold: (text: string) => text })).toBe(" Jobs ● 1 running · /jobs ");
  expect(card.renderBody(60, 5, plain)).toEqual(["● Serve the fixture"]);
  await run("job_wait", { id: (await run("job_stop", { id: details.id })).details.id, wait_ms: 3000 });
  expect(card.visible()).toBe(false);
});

test("job IDs accept an unambiguous prefix", async () => {
  const saved = (id: string) => ({ type: "custom", customType: JOB_HISTORY_ENTRY, data: encodeJob({ id, name: id, command: "true", cwd: "/", status: "completed", startedAt: 1, endedAt: 2, code: 0, outputStart: 0, outputEnd: 2, tail: `${id}\n` }) });
  const { run } = await session("json", {}, [saved("zz111111"), saved("zz122222")]);
  await expect(run("job_output", { id: "zz1" })).rejects.toThrow("Job ID prefix zz1 is ambiguous: zz111111, zz122222.");
  expect(outputOf(await run("job_output", { id: "zz12", cursor: 0 }))).toBe("zz122222\n");
  const live = (await run("bash", { command: "sleep 5", yield_ms: 0 })).details.id;
  expect((await run("job_stop", { id: live.slice(0, 6) })).details.id).toBe(live);
});

test("/jobs stop asks for confirmation when a UI is available", async () => {
  const answers: boolean[] = [false, true];
  const prompts: string[] = [];
  const ui = { notify() {}, confirm: async (title: string, body: string) => { prompts.push(`${title}\n${body}`); return answers.shift()!; } };
  const { run, commands, ctx } = await session("json", { hasUI: true, ui });
  const id = (await run("bash", { command: "sleep 5", purpose: "Serve the fixture", yield_ms: 0 })).details.id;
  await commands.get("jobs").handler(`stop ${id}`, ctx);
  expect(prompts[0]).toStartWith(`Stop background job?\nServe the fixture · ${id}\n`);
  expect(["starting", "running"]).toContain((await run("job_output", { id })).details.status);
  await commands.get("jobs").handler("stop all", ctx);
  expect(prompts).toHaveLength(2);
  expect(["stopping", "stopped"]).toContain((await run("job_output", { id })).details.status);
});
