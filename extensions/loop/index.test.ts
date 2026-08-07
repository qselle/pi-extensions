import { expect, test } from "bun:test";
import { createLoop } from "./loop.ts";

const { default: loopExtension } = await import("./index.ts");

type Handler = (event: any, ctx: any) => any;

class MockPi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, any>();
  tools = new Map<string, any>();
  entries: any[] = [];
  sent: any[] = [];

  on(event: string, handler: Handler) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  registerTool(tool: any) { this.tools.set(tool.name, tool); }
  appendEntry(customType: string, data: unknown) { this.entries.push({ type: "custom", customType, data }); }
  sendMessage(message: unknown, options: unknown) { this.sent.push({ message, options }); }
  async emit(event: string, payload: unknown, ctx: any) {
    const results = [];
    for (const handler of this.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  }
}

function mockContext(pi: MockPi, cwd = process.cwd()) {
  const notifications: string[] = [];
  const statuses: unknown[] = [];
  return {
    cwd,
    mode: "tui",
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ percent: 10 }),
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => pi.entries },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: (...args: unknown[]) => statuses.push(args),
    },
    notifications,
    statuses,
  };
}

test("bare and interval-only commands use the bounded maintenance prompt", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  loopExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  await pi.commands.get("loop").handler("15m", ctx);
  await Bun.sleep(20);

  expect(pi.entries.at(-1).data.jobs[0].promptSource).toBe("default");
  expect(pi.entries.at(-1).data.jobs[0].intervalMs).toBe(900_000);
  await pi.emit("agent_start", {}, ctx);
  const [transformed] = await pi.emit("context", {
    messages: [{ role: "custom", ...pi.sent[0].message, timestamp: Date.now() }],
  }, ctx);
  expect(transformed.messages[0].content).toContain("Continue any unfinished work already authorized");
  await pi.emit("agent_settled", {}, ctx);
  await pi.commands.get("loop").handler("stop all", ctx);
  await pi.emit("session_shutdown", {}, ctx);
});

test("starts a fixed loop immediately and arms its next cadence", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  loopExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  await pi.commands.get("loop").handler("5m check the deploy", ctx);
  await Bun.sleep(20);

  expect(pi.sent).toHaveLength(1);
  expect(pi.sent[0].message.customType).toBe("loop-wakeup");
  expect(pi.sent[0].options).toEqual({ triggerTurn: true });

  await pi.emit("agent_start", {}, ctx);
  const [transformed] = await pi.emit("context", {
    messages: [{ role: "custom", ...pi.sent[0].message, timestamp: Date.now() }],
  }, ctx);
  expect(transformed.messages[0].content).toContain("Scheduled loop iteration 1/25");
  expect(transformed.messages[0].content).toContain("Task: check the deploy");
  expect(transformed.messages[0].content).toContain("every 5m");

  await pi.emit("agent_settled", {}, ctx);
  const job = pi.entries.at(-1).data.jobs[0];
  expect(job.iterations).toBe(1);
  expect(job.nextRunAt).toBeGreaterThan(Date.now());
  await pi.emit("session_shutdown", {}, ctx);
});

test("dynamic loops accept a model-selected wake and can stop themselves", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  loopExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  await pi.commands.get("loop").handler("watch CI", ctx);
  await Bun.sleep(20);
  await pi.emit("agent_start", {}, ctx);

  const scheduled = await pi.tools.get("loop_schedule").execute(
    "schedule",
    { delay_seconds: 120, reason: "CI is still running" },
    undefined,
    undefined,
    ctx,
  );
  expect(scheduled.content[0].text).toContain("will wake in 2m");
  expect(pi.entries.at(-1).data.jobs[0].nextRunAt).toBeGreaterThan(Date.now());

  const stopped = await pi.tools.get("loop_stop").execute(
    "stop",
    { reason: "CI passed" },
    undefined,
    undefined,
    ctx,
  );
  expect(stopped.content[0].text).toContain("stopped");
  expect(pi.entries.at(-1).data.jobs[0].status).toBe("stopped");
  await pi.emit("agent_settled", {}, ctx);
  await pi.emit("session_shutdown", {}, ctx);
});

test("dynamic loops get one fallback before stopping on missing schedules", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  loopExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  await pi.commands.get("loop").handler("watch CI", ctx);
  await Bun.sleep(20);
  await pi.emit("agent_start", {}, ctx);
  await pi.emit("agent_settled", {}, ctx);

  const job = pi.entries.at(-1).data.jobs[0];
  expect(job.status).toBe("active");
  expect(job.fallbackWakeups).toBe(1);
  expect(ctx.notifications.some((message) => message.includes("fallback"))).toBe(true);
  await pi.commands.get("loop").handler(`stop ${job.id}`, ctx);
  await pi.emit("session_shutdown", {}, ctx);
});

test("interruptions and provider errors pause the owning loop", async () => {
  for (const [stopReason, expected] of [["aborted", "interrupted"], ["error", "Agent run failed"]] as const) {
    const pi = new MockPi();
    const ctx = mockContext(pi);
    loopExtension(pi as any);
    await pi.emit("session_start", {}, ctx);
    await pi.commands.get("loop").handler("5m check the deploy", ctx);
    await Bun.sleep(20);
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("message_end", {
      message: { role: "assistant", stopReason, errorMessage: stopReason === "error" ? "rate limited" : undefined },
    }, ctx);

    const job = pi.entries.at(-1).data.jobs[0];
    expect(job.status).toBe("paused");
    expect(job.stopReason).toContain(expected);
    await pi.emit("agent_settled", {}, ctx);
    expect(pi.entries.at(-1).data.jobs[0].status).toBe("paused");
    await pi.emit("session_shutdown", {}, ctx);
  }
});

test("resume cannot bypass the active-loop cap", async () => {
  const now = Date.now();
  const jobs = Array.from({ length: 8 }, (_, index) => createLoop(`active ${index}`, 300_000, now, `active-${index}`));
  jobs.push({ ...createLoop("paused", 300_000, now, "paused"), status: "paused", nextRunAt: null });
  const pi = new MockPi();
  pi.entries.push({ type: "custom", customType: "loop-state", data: { version: 2, jobs } });
  const ctx = mockContext(pi);
  loopExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  await pi.commands.get("loop").handler("resume paused", ctx);

  expect(ctx.notifications.at(-1)).toContain("At most 8 loops may be active");
  expect(pi.entries.at(-1).data.jobs.find((job: any) => job.id === "paused").status).toBe("paused");
  await pi.commands.get("loop").handler("stop all", ctx);
  await pi.emit("session_shutdown", {}, ctx);
});

test("restores session state and coalesces an overdue wakeup", async () => {
  const pi = new MockPi();
  pi.entries.push({
    type: "custom",
    customType: "loop-state",
    data: {
      version: 1,
      jobs: [{
        id: "restored",
        prompt: "check deploy",
        mode: "fixed",
        status: "active",
        intervalMs: 300_000,
        nextRunAt: Date.now() - 60_000,
        createdAt: Date.now() - 120_000,
        expiresAt: Date.now() + 3_600_000,
        iterations: 2,
        maxIterations: 25,
        fallbackWakeups: 0,
      }],
    },
  });
  const ctx = mockContext(pi);
  loopExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  await Bun.sleep(20);
  expect(pi.sent).toHaveLength(1);
  expect(pi.sent[0].message.details.loopId).toBe("restored");
  await pi.commands.get("loop").handler("stop restored", ctx);
  await pi.emit("session_shutdown", {}, ctx);
});

test("late settlement after shutdown cannot re-arm a loop", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  loopExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  await pi.commands.get("loop").handler("watch CI", ctx);
  await Bun.sleep(20);
  await pi.emit("agent_start", {}, ctx);
  await pi.emit("session_shutdown", {}, ctx);
  const entriesAfterShutdown = pi.entries.length;

  await pi.emit("agent_settled", {}, ctx);
  await Bun.sleep(20);
  expect(pi.sent).toHaveLength(1);
  expect(pi.entries).toHaveLength(entriesAfterShutdown);
});
