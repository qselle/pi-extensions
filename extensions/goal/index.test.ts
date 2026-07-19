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
  Input: class Input {
    private value = "";
    focused = false;
    getValue() { return this.value; }
    setValue(value: string) { this.value = value; }
    handleInput(data: string) {
      if (data === "backspace") this.value = this.value.slice(0, -1);
      else if (data === "ctrl+u") this.value = "";
      else if (data.length === 1 && data >= " ") this.value += data;
    }
    render(width: number) { return [this.value.slice(0, width)]; }
    invalidate() {}
  },
  Text: class Text {
    constructor(public text: string) {}
    render() { return [this.text]; }
    invalidate() {}
  },
  matchesKey: (data: string, key: string) => data === key,
  truncateToWidth: (value: string, width: number) => value.slice(0, width),
  visibleWidth: (value: string) => value.length,
  wrapTextWithAnsi: (value: string) => [value],
  sliceByColumn: (value: string, start: number, width: number) => value.slice(start, start + width),
}));

const { default: goalExtension } = await import("./index.ts");
const { GoalPanel, GoalWidget, goalOverlayTitle, renderGoalOverlayBody } = await import("./ui.ts");
const { createGoal, recordGoalBlocker, reportGoalProgress } = await import("./goal.ts");

type Handler = (event: any, ctx: any) => any;

class MockPi {
  handlers = new Map<string, Handler[]>();
  eventHandlers = new Map<string, Set<(event: unknown) => void>>();
  events = {
    on: (name: string, handler: (event: unknown) => void) => {
      const handlers = this.eventHandlers.get(name) ?? new Set();
      handlers.add(handler);
      this.eventHandlers.set(name, handlers);
      return () => handlers.delete(handler);
    },
    emit: (name: string, event: unknown) => {
      for (const handler of this.eventHandlers.get(name) ?? []) handler(event);
    },
  };
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
  sendMessage(message: unknown, options: unknown) { this.sent.push({ kind: "custom", message, options }); }
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

function assistantMessage(tokens: number, text?: string) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
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

test("starts fresh goal continuations with a hidden prompt marker from safe idle boundaries", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.commands.get("goal").handler("Ship the goal extension", ctx);
  await Bun.sleep(40);

  expect(pi.entries.at(-1).data.goal.objective).toBe("Ship the goal extension");
  expect(pi.entries.at(-1).data.goal.status).toBe("active");
  expect(pi.sent).toHaveLength(1);
  expect(pi.sent[0].kind).toBe("custom");
  expect((pi.sent[0].message as any).customType).toBe("goal-continuation");
  expect((pi.sent[0].message as any).content).toBe("Continue the active goal.");
  expect(pi.sent[0].options).toEqual({ triggerTurn: true });

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

test("tool-created goals use a hidden prompt marker for their first continuation", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.emit("agent_start", {}, ctx);
  await pi.tools.get("create_goal").execute("create", {
    objective: "Complete a fresh multi-run goal",
  }, undefined, undefined, ctx);
  expect(pi.sent).toHaveLength(0);

  await pi.emit("agent_settled", {}, ctx);
  await Bun.sleep(40);

  expect(pi.sent).toHaveLength(1);
  expect(pi.sent[0].kind).toBe("custom");
  expect((pi.sent[0].message as any).customType).toBe("goal-continuation");
  expect((pi.sent[0].message as any).content).toBe("Continue the active goal.");

  await pi.commands.get("goal").handler("pause", ctx);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("injects full goal context transiently while storing only small markers", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.commands.get("goal").handler("Ship <safe> goal context", ctx);
  await Bun.sleep(40);
  expect(pi.sent[0].kind).toBe("custom");
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
  expect(transformed.messages[0].role).toBe("custom");
  expect(transformed.messages[0].customType).toBe("goal-context");
  expect(transformed.messages[0].content).toContain("Persistent goal continuation");
  expect(transformed.messages[0].content).toContain("Ship &lt;safe&gt; goal context");
  expect(pi.entries.some((entry) => JSON.stringify(entry).includes("Persistent goal continuation"))).toBe(false);

  await pi.emit("agent_settled", {}, ctx);
  await pi.commands.get("goal").handler("pause", ctx);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("expands the tiny continuation marker when before_agent_start is bypassed", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.commands.get("goal").handler("Execute the continuation objective", ctx);
  await Bun.sleep(40);
  await pi.emit("agent_start", {}, ctx);

  const [transformed] = await pi.emit("context", {
    messages: [{ role: "custom", ...(pi.sent[0].message as object), timestamp: 1 }],
  }, ctx);
  expect(transformed.messages).toHaveLength(1);
  expect(transformed.messages[0].role).toBe("custom");
  expect(transformed.messages[0].customType).toBe("goal-context");
  expect(transformed.messages[0].content).toContain("Persistent goal continuation");
  expect(transformed.messages[0].content).toContain("Execute the continuation objective");

  await pi.emit("tool_execution_end", {}, ctx);
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

test("a concrete progress report revives a stalled goal when implementation continues", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.commands.get("goal").handler("Continue implementation after a transient failure", ctx);
  await Bun.sleep(40);
  await pi.emit("agent_start", {}, ctx);
  await pi.emit("message_end", {
    message: {
      ...assistantMessage(10),
      stopReason: "error",
      errorMessage: "WebSocket error",
    },
  }, ctx);
  await pi.emit("agent_settled", {}, ctx);
  expect(pi.entries.at(-1).data.goal.status).toBe("stalled");

  const [stalledStart] = await pi.emit("before_agent_start", { systemPrompt: "base" }, ctx);
  expect(stalledStart.message.customType).toBe("goal-context");
  const [stalledContext] = await pi.emit("context", { messages: [stalledStart.message] }, ctx);
  expect(stalledContext.messages[0].content).toContain("State: stalled");
  expect(stalledContext.messages[0].content).toContain("safely reactivates the goal");

  await pi.emit("agent_start", {}, ctx);
  await expect(pi.tools.get("report_goal_progress").execute("invalid-progress", {
    checks: [{ content: "Implementation might continue", status: "pending" }],
  }, undefined, undefined, ctx)).rejects.toThrow("exactly one in-progress check");
  expect(pi.entries.at(-1).data.goal.status).toBe("stalled");

  const result = await pi.tools.get("report_goal_progress").execute("progress", {
    checks: [
      { content: "Implementation is continuing", status: "in_progress" },
      { content: "Verify the final behavior", status: "pending" },
    ],
    summary: "Recovered after a transient provider failure",
  }, undefined, undefined, ctx);
  expect(result.details.message).toContain("Goal resumed");
  expect(pi.entries.at(-1).data.goal.status).toBe("active");
  expect(pi.entries.at(-1).data.goal.stallReason).toBeUndefined();

  await pi.emit("tool_execution_end", {}, ctx);
  await pi.emit("agent_settled", {}, ctx);
  await Bun.sleep(40);
  expect(pi.sent).toHaveLength(2);
  await pi.commands.get("goal").handler("pause", ctx);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("does not auto-revive provider-capacity stops", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.commands.get("goal").handler("Wait safely when provider capacity is exhausted", ctx);
  await Bun.sleep(40);
  await pi.emit("agent_start", {}, ctx);
  await pi.emit("message_end", {
    message: {
      ...assistantMessage(10),
      stopReason: "error",
      errorMessage: "429 usage limit exceeded",
    },
  }, ctx);
  await pi.emit("agent_settled", {}, ctx);
  expect(pi.entries.at(-1).data.goal.status).toBe("usage_limited");

  const [startContext] = await pi.emit("before_agent_start", { systemPrompt: "base" }, ctx);
  expect(startContext).toBeUndefined();
  await expect(pi.tools.get("report_goal_progress").execute("progress", {
    checks: [{ content: "Wait for provider capacity", status: "in_progress" }],
  }, undefined, undefined, ctx)).rejects.toThrow("only while the goal is active");
  expect(pi.entries.at(-1).data.goal.status).toBe("usage_limited");
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("stalls immediately when a no-tool continuation replays the previous response", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  const replayed = "This is the exact previous assistant response.";
  await pi.emit("message_end", { message: assistantMessage(100, replayed) }, ctx);
  await pi.commands.get("goal").handler("Make concrete progress instead of replaying output", ctx);
  await Bun.sleep(40);

  await pi.emit("agent_start", {}, ctx);
  await pi.emit("message_end", { message: assistantMessage(100, replayed) }, ctx);
  await pi.emit("agent_settled", {}, ctx);
  await Bun.sleep(40);

  expect(pi.entries.at(-1).data.goal.status).toBe("stalled");
  expect(pi.entries.at(-1).data.goal.stallReason).toContain("repeated the previous assistant response");
  expect(pi.sent).toHaveLength(1);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("stalls instead of fabricating a blocker after three empty continuation runs", async () => {
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

  expect(pi.entries.at(-1).data.goal.status).toBe("stalled");
  expect(pi.entries.at(-1).data.goal.stallReason).toContain("no tool call");
  expect(pi.entries.at(-1).data.goal.blockerAudit).toBeUndefined();
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
  for (const width of [28, 54, 72]) {
    const lines = renderGoalOverlayBody(state, width, 6, theme);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.every((line: string) => line.length <= width)).toBe(true);
  }
  expect(goalOverlayTitle(state, theme)).toContain("ACTIVE");

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
