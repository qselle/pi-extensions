import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-ai", () => ({
  StringEnum: (values: readonly string[]) => ({ type: "string", enum: values }),
}));

mock.module("typebox", () => ({
  Type: {
    Object: (properties: unknown) => ({ type: "object", properties }),
    String: (options?: unknown) => ({ type: "string", ...options as object }),
    Integer: (options?: unknown) => ({ type: "integer", ...options as object }),
    Array: (items: unknown, options?: unknown) => ({ type: "array", items, ...options as object }),
    Optional: (schema: unknown) => schema,
  },
}));

mock.module("@earendil-works/pi-tui", () => ({
  Text: class Text {
    constructor(public text: string) {}
    render() { return [this.text]; }
    invalidate() {}
  },
  matchesKey: (data: string, key: string) => data === key,
  truncateToWidth: (value: string, width: number) => value.slice(0, width),
  visibleWidth: (value: string) => value.length,
  wrapTextWithAnsi: (value: string) => [value],
}));

const { default: goalExtension } = await import("./index.ts");
const { GoalPanel, GoalWidget } = await import("./ui.ts");
const { createGoal, recordGoalBlocker, reportGoalProgress } = await import("./goal.ts");

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
  appendEntry(customType: string, data: unknown) {
    this.entries.push({ type: "custom", customType, data });
  }
  sendMessage(message: unknown, options: unknown) { this.sent.push({ message, options }); }
  async emit(event: string, payload: unknown, ctx: any) {
    const results = [];
    for (const handler of this.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  }
}

function mockContext(pi: MockPi) {
  const notifications: string[] = [];
  const widgets: unknown[] = [];
  return {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => pi.entries },
    ui: {
      notify: (message: string) => notifications.push(message),
      setWidget: (...args: unknown[]) => widgets.push(args),
      confirm: async () => true,
      editor: async () => undefined,
      custom: async () => "close",
      theme: { fg: (_color: string, value: string) => value },
    },
    notifications,
    widgets,
  };
}

function assistantMessage(tokens: number) {
  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("persists command state and continues only from safe idle boundaries", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.commands.get("goal").handler("Ship the goal extension", ctx);
  await Bun.sleep(40);

  expect(pi.entries.at(-1).data.goal.objective).toBe("Ship the goal extension");
  expect(pi.entries.at(-1).data.goal.status).toBe("active");
  expect(pi.sent).toHaveLength(1);
  expect((pi.sent[0].message as any).customType).toBe("goal-continuation");

  await pi.emit("agent_start", {}, ctx);
  await pi.emit("message_end", { message: assistantMessage(250) }, ctx);
  await pi.emit("tool_execution_end", {}, ctx);
  await pi.emit("agent_settled", {}, ctx);
  await Bun.sleep(40);

  expect(pi.entries.at(-1).data.goal.tokensUsed).toBe(250);
  expect(pi.entries.at(-1).data.goal.turns).toBe(1);
  expect(pi.sent).toHaveLength(2);

  await pi.commands.get("goal").handler("pause", ctx);
  expect(pi.entries.at(-1).data.goal.status).toBe("paused");

  const result = await pi.tools.get("get_goal").execute("call", {}, undefined, undefined, ctx);
  expect(JSON.parse(result.content[0].text).goal.status).toBe("paused");

  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("injects full goal context transiently while storing only small markers", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.commands.get("goal").handler("Ship <safe> goal context", ctx);
  await Bun.sleep(40);
  expect((pi.sent[0].message as any).content).toBe("Continue the active goal.");
  expect((pi.sent[0].message as any).content).not.toContain("safe");

  const [injection] = await pi.emit("before_agent_start", {}, ctx);
  expect(injection.message.content).toBe("Active goal context.");
  await pi.emit("agent_start", {}, ctx);
  const [transformed] = await pi.emit("context", {
    messages: [
      { role: "custom", customType: "goal-context", content: "stale", display: false, timestamp: 1 },
      { role: "custom", ...(pi.sent[0].message as object), timestamp: 2 },
      { role: "custom", ...injection.message, timestamp: 3 },
    ],
  }, ctx);

  expect(transformed.messages).toHaveLength(1);
  expect(transformed.messages[0].customType).toBe("goal-context");
  expect(transformed.messages[0].content).toContain("Persistent goal continuation");
  expect(transformed.messages[0].content).toContain("Ship &lt;safe&gt; goal context");
  expect(pi.entries.some((entry) => JSON.stringify(entry).includes("Persistent goal continuation"))).toBe(false);

  await pi.emit("agent_settled", {}, ctx);
  await pi.commands.get("goal").handler("pause", ctx);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("tracks progress checks and refuses premature completion", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  ctx.mode = "rpc";
  goalExtension(pi as any);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.commands.get("goal").handler("Finish the release", ctx);
  const progress = pi.tools.get("report_goal_progress");
  const update = pi.tools.get("update_goal");

  await progress.execute("progress-1", {
    checks: [
      { content: "Run the tests", status: "complete" },
      { content: "Inspect the release", status: "in_progress" },
    ],
    summary: "Tests pass",
  }, undefined, undefined, ctx);

  await expect(update.execute("complete-1", { status: "complete" }, undefined, undefined, ctx))
    .rejects.toThrow("1 progress check(s) remain unfinished");

  await progress.execute("progress-2", {
    checks: [
      { content: "Run the tests", status: "complete" },
      { content: "Inspect the release", status: "complete" },
    ],
    summary: "Release verified",
  }, undefined, undefined, ctx);
  await update.execute("complete-2", { status: "complete" }, undefined, undefined, ctx);

  expect(pi.entries.at(-1).data.goal.status).toBe("complete");
  expect(pi.entries.at(-1).data.goal.progressSummary).toBe("Release verified");
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("requires the same blocker in three separate runs", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  ctx.mode = "rpc";
  goalExtension(pi as any);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.commands.get("goal").handler("Publish the release", ctx);
  const update = pi.tools.get("update_goal");
  const args = {
    status: "blocked",
    blocker: "Signing service is unavailable",
    evidence: "Health endpoint returns 503",
    next_input: "Restore the signing service",
  };

  for (let run = 1; run <= 3; run++) {
    await pi.emit("agent_start", {}, ctx);
    const result = await update.execute(`blocked-${run}`, args, undefined, undefined, ctx);
    await pi.emit("tool_execution_end", {}, ctx);
    await pi.emit("agent_settled", {}, ctx);
    expect(result.details.blockerCount).toBe(run);
  }

  expect(pi.entries.at(-1).data.goal.status).toBe("blocked");
  expect(pi.entries.at(-1).data.goal.blockerAudit.count).toBe(3);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("stops after three continuation runs with no tool activity", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.commands.get("goal").handler("Exercise anti-spin protection", ctx);
  await Bun.sleep(40);

  for (let run = 1; run <= 3; run++) {
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("agent_settled", {}, ctx);
    if (run < 3) await Bun.sleep(40);
  }

  expect(pi.entries.at(-1).data.goal.status).toBe("blocked");
  expect(pi.entries.at(-1).data.goal.blockerAudit.description).toContain("no tool calls");
  expect(pi.sent).toHaveLength(3);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("keeps compact and expanded goal UI within responsive widths", () => {
  const theme = {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
    bold: (value: string) => value,
    italic: (value: string) => value,
    strikethrough: (value: string) => value,
  } as any;
  let state = createGoal(
    "Build a polished persistent goal extension with a responsive widget and reliable continuation behavior",
    { id: "goal-ui", now: 0, tokenBudget: 50_000 },
  );
  state = reportGoalProgress(state, [
    { content: "Research durable goal loops", status: "complete" },
    { content: "Implement transient context", status: "in_progress" },
    { content: "Verify narrow layouts", status: "pending" },
  ]);
  state = { ...state, tokensUsed: 12_500, timeUsedMs: 90_000, turns: 4 };

  for (const width of [20, 41, 42, 60, 100]) {
    const lines = new GoalWidget(theme, () => state, () => undefined).render(width);
    expect(lines.every((line: string) => line.length <= width)).toBe(true);
  }

  const blocked = recordGoalBlocker(
    state,
    { description: "Signing service unavailable", nextInput: "Restore the service" },
    4,
  ).goal;
  for (const view of [state, blocked]) {
    for (const width of [44, 60, 100]) {
      const lines = new GoalPanel(view, theme, undefined, () => {}).render(width);
      expect(lines.every((line: string) => line.length <= width)).toBe(true);
    }
  }
});
