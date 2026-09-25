import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-ai", () => ({
  StringEnum: (values: readonly string[]) => ({ type: "string", enum: values }),
}));

mock.module("typebox", () => ({
  Type: {
    Object: (properties: unknown) => ({ type: "object", properties }),
    String: (options?: unknown) => ({ type: "string", ...options as object }),
    Boolean: (options?: unknown) => ({ type: "boolean", ...options as object }),
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
const { GOAL_COMPLETED_EVENT } = await import("./events.ts");
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
    sessionManager: { getBranch: () => pi.entries, getSessionId: () => "session" },
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

test("emits one versioned completion event after final accounting", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  ctx.mode = "rpc";
  const completions: any[] = [];
  pi.events.on(GOAL_COMPLETED_EVENT, (event) => completions.push(event));
  goalExtension(pi as any);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.commands.get("goal").handler("Verify completion events", ctx);
  await pi.emit("agent_start", {}, ctx);
  await pi.tools.get("report_goal_progress").execute("progress", {
    checks: [{ content: "Verify final accounting", status: "complete" }],
    summary: "All completion behavior verified",
  }, undefined, undefined, ctx);
  await pi.tools.get("update_goal").execute("complete", { status: "complete" }, undefined, undefined, ctx);

  expect(completions).toHaveLength(0);
  await expect(pi.tools.get("update_goal").execute("duplicate", { status: "complete" }, undefined, undefined, ctx))
    .rejects.toThrow("already complete");
  await pi.emit("message_end", { message: assistantMessage(321) }, ctx);
  await Bun.sleep(2);
  await pi.emit("agent_settled", {}, ctx);

  expect(completions).toHaveLength(1);
  expect(completions[0]).toMatchObject({
    version: 1,
    completedAt: expect.any(Number),
    completionId: expect.any(String),
    goal: {
      objective: "Verify completion events",
      status: "complete",
      tokensUsed: 321,
      progressSummary: "All completion behavior verified",
    },
  });
  expect(completions[0].goal.timeUsedMs).toBeGreaterThanOrEqual(1);

  await pi.emit("agent_settled", {}, ctx);
  await pi.emit("session_tree", {}, ctx);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  expect(completions).toHaveLength(1);
});

test("emits a pending completion during shutdown fallback", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  ctx.mode = "rpc";
  const completions: any[] = [];
  pi.events.on(GOAL_COMPLETED_EVENT, (event) => completions.push(event));
  goalExtension(pi as any);

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.commands.get("goal").handler("Complete before shutdown", ctx);
  await pi.emit("agent_start", {}, ctx);
  await pi.tools.get("update_goal").execute("complete", { status: "complete" }, undefined, undefined, ctx);
  expect(completions).toHaveLength(0);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  expect(completions).toHaveLength(1);
  expect(completions[0].goal.status).toBe("complete");
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
    condition_id: "signing-service.unavailable",
    blocker: "Signing service is unavailable",
    evidence: "Health endpoint returns 503",
    next_input: "Restore the signing service",
  };

  for (let run = 1; run <= 3; run++) {
    await pi.emit("agent_start", {}, ctx);
    const result = await update.execute(`blocked-${run}`, { ...args, blocker: `${args.blocker}; attempt ${run}` }, undefined, undefined, ctx);
    await pi.emit("tool_execution_end", {}, ctx);
    await pi.emit("agent_settled", {}, ctx);
    expect(result.details.blockerCount).toBe(run);
  }

  expect(pi.entries.at(-1).data.goal.status).toBe("blocked");
  expect(pi.entries.at(-1).data.goal.blockerAudit.count).toBe(3);
  expect(pi.entries.at(-1).data.goal.blockerAudit.conditionId).toBe(args.condition_id);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("a stalled goal resumes only through explicit resume and request reconciliation", async () => {
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
  expect(stalledContext.messages[0].content).toContain("A progress report never resumes a goal");

  await pi.emit("agent_start", {}, ctx);
  await expect(pi.tools.get("report_goal_progress").execute("invalid-progress", {
    checks: [{ content: "Implementation might continue", status: "pending" }],
  }, undefined, undefined, ctx)).rejects.toThrow("only while the goal is active");
  expect(pi.entries.at(-1).data.goal.status).toBe("stalled");

  await pi.emit("input", { source: "interactive", text: "Resume implementation" }, ctx);
  const beforeResume = pi.entries.at(-1).data.goal;
  const resumed = await pi.tools.get("resume_goal").execute("resume", {
    goal_id: beforeResume.id, request_id: beforeResume.reconciliation.requestId,
  }, undefined, undefined, ctx);
  const current = resumed.details.goal;
  await pi.tools.get("reconcile_goal").execute("keep", {
    goal_id: current.id, request_id: current.reconciliation.requestId, action: "keep",
  }, undefined, undefined, ctx);
  await expect(pi.tools.get("report_goal_progress").execute("invalid-progress", {
    checks: [{ content: "Implementation might continue", status: "pending" }],
  }, undefined, undefined, ctx)).rejects.toThrow("exactly one in-progress check");

  const result = await pi.tools.get("report_goal_progress").execute("progress", {
    checks: [
      { content: "Implementation is continuing", status: "in_progress" },
      { content: "Verify the final behavior", status: "pending" },
    ],
    summary: "Recovered after a transient provider failure",
  }, undefined, undefined, ctx);
  expect(result.details.message).toContain("Goal progress");
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
  const [inactiveContext] = await pi.emit("context", { messages: [startContext.message] }, ctx);
  expect(inactiveContext.messages[0].content).toContain("State: usage_limited");
  expect(inactiveContext.messages[0].content).toContain("Resume only when the user explicitly asks");
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

for (const action of ["clear", "edit", "replacement", "panel"] as const) {
  test(`stale ${action} dialog cannot change a goal restored on another branch`, async () => {
    const pi = new MockPi();
    const ctx = mockContext(pi);
    goalExtension(pi as any);
    await pi.commands.get("goal").handler("Original objective", ctx);
    let release!: (value: any) => void;
    const pending = new Promise<any>((resolve) => { release = resolve; });
    if (action === "edit") ctx.ui.editor = () => pending;
    else if (action === "panel") ctx.ui.custom = () => pending;
    else ctx.ui.confirm = () => pending;
    const running = pi.commands.get("goal").handler(action === "replacement" ? "Replacement objective" : action === "panel" ? "" : action, ctx);
    const replacement = createGoal("Other branch objective");
    pi.entries.push({ type: "custom", customType: "goal-state", data: { version: 2, goal: replacement } });
    await pi.emit("session_tree", {}, ctx);
    const count = pi.entries.length;
    release(action === "edit" ? "Edited old objective" : action === "panel" ? "pause" : true);
    await running;
    expect(pi.entries).toHaveLength(count);
    const result = await pi.tools.get("get_goal").execute("read", {}, undefined, undefined, ctx);
    expect(JSON.parse(result.content[0].text).goal.objective).toBe("Other branch objective");
    await pi.emit("session_shutdown", {}, ctx);
  });
}

test("a pending clear dialog cannot schedule continuation after shutdown", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);
  await pi.commands.get("goal").handler("Original objective", ctx);
  let release!: (value: boolean) => void;
  ctx.ui.confirm = () => new Promise((resolve) => { release = resolve; });
  const running = pi.commands.get("goal").handler("clear", ctx);
  await pi.emit("session_shutdown", {}, ctx);
  const count = pi.entries.length;
  release(true);
  await running;
  await Bun.sleep(40);
  expect(pi.entries).toHaveLength(count);
  expect(pi.sent).toHaveLength(0);
});

function goalIdentifiers(goal: any) {
  return { goal_id: goal.id, request_id: goal.reconciliation.requestId };
}

test("user input gates continuation and progress until unchanged scope is reconciled", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  await pi.commands.get("goal").handler("Ship and verify the complete feature", ctx);
  await pi.emit("input", { source: "rpc", text: "How far along are we?" }, ctx);
  const pending = pi.entries.at(-1).data.goal;
  await Bun.sleep(40);
  expect(pi.sent).toHaveLength(0);
  await pi.emit("agent_start", {}, ctx);
  for (const [name, parameters] of [
    ["report_goal_progress", { checks: [] }],
    ["update_goal", { status: "complete" }],
    ["update_goal", { status: "blocked", blocker: "Unavailable" }],
  ] as const) {
    await expect(pi.tools.get(name).execute(name, parameters, undefined, undefined, ctx)).rejects.toThrow("reconcile_goal");
  }
  await pi.tools.get("reconcile_goal").execute("keep", { ...goalIdentifiers(pending), action: "keep" }, undefined, undefined, ctx);
  await pi.emit("message_end", { message: assistantMessage(30, "Here is the current progress.") }, ctx);
  await pi.emit("agent_settled", {}, ctx);
  await Bun.sleep(40);
  const after = pi.entries.at(-1).data.goal;
  expect(after.status).toBe("active");
  expect(after.objective).toBe(pending.objective);
  expect(after.id).toBe(pending.id);
  expect(after.tokensUsed).toBe(30);
  expect(after.reconciliation).toBeUndefined();
  expect(pi.sent).toHaveLength(1);
  await pi.emit("session_shutdown", {}, ctx);
});

test("unresolved or invalid revisions persist as an actionable stalled state across reload", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  const attention: unknown[] = [];
  pi.events.on("goal:attention", (event) => attention.push(event));
  goalExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  await pi.commands.get("goal").handler("Implement all requested behavior", ctx);
  await pi.emit("input", { source: "interactive", text: "Include migrations in the feature" }, ctx);
  await pi.emit("agent_start", {}, ctx);
  const pending = pi.entries.at(-1).data.goal;
  await expect(pi.tools.get("reconcile_goal").execute("invalid", {
    ...goalIdentifiers(pending), action: "revise", objective: "Implement including migrations",
  }, undefined, undefined, ctx)).rejects.toThrow("complete checks list");
  await pi.emit("message_end", { message: assistantMessage(12) }, ctx);
  await pi.emit("agent_settled", {}, ctx);
  const paused = pi.entries.at(-1).data.goal;
  expect(paused.status).toBe("stalled");
  expect(paused.reconciliation).toEqual(pending.reconciliation);
  expect(paused.objective).toBe(pending.objective);
  expect(paused.tokensUsed).toBe(12);
  expect(paused.stallReason).toContain("latest user request");
  expect(ctx.notifications.filter((message) => message.includes("latest request was not reconciled"))).toHaveLength(1);
  expect(attention).toHaveLength(1);
  await pi.emit("session_tree", {}, ctx);
  const restored = pi.entries.at(-1).data.goal;
  expect(restored.status).toBe("stalled");
  expect(restored.reconciliation.requestId).not.toBe(paused.reconciliation.requestId);
  expect(restored.reconciliation.requestedAt).toBe(paused.reconciliation.requestedAt);
  expect(attention).toHaveLength(1);
  expect(restored.tokensUsed).toBe(12);
  await Bun.sleep(40);
  expect(pi.sent).toHaveLength(0);
  await expect(pi.tools.get("resume_goal").execute("stale", goalIdentifiers(paused), undefined, undefined, ctx)).rejects.toThrow("request changed");
  await pi.commands.get("goal").handler("resume", ctx);
  expect(pi.entries.at(-1).data.goal.reconciliation).toBeUndefined();
  expect(pi.entries.at(-1).data.goal.status).toBe("active");
  await Bun.sleep(40);
  expect(pi.sent).toHaveLength(1);
  await pi.emit("session_shutdown", {}, ctx);
});

test("new requests, goal replacement, aborted tools and shutdown reject stale goal controls", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  await pi.commands.get("goal").handler("First objective", ctx);
  await pi.emit("input", { source: "interactive", text: "Add a requirement" }, ctx);
  const first = pi.entries.at(-1).data.goal;
  await pi.emit("input", { source: "interactive", text: "Actually preserve the old scope" }, ctx);
  const latest = pi.entries.at(-1).data.goal;
  await pi.emit("input", { source: "extension", text: "Background metadata" }, ctx);
  expect(pi.entries.at(-1).data.goal.reconciliation).toEqual(latest.reconciliation);
  await expect(pi.tools.get("reconcile_goal").execute("stale", { ...goalIdentifiers(first), action: "pause" }, undefined, undefined, ctx)).rejects.toThrow("request changed");
  await expect(pi.tools.get("reconcile_goal").execute("aborted", { ...goalIdentifiers(latest), action: "keep" }, AbortSignal.abort(), undefined, ctx)).rejects.toThrow();
  expect(pi.entries.at(-1).data.goal.reconciliation).toEqual(latest.reconciliation);
  await pi.commands.get("goal").handler("Second objective", ctx);
  await expect(pi.tools.get("clear_goal").execute("stale", goalIdentifiers(latest), undefined, undefined, ctx)).rejects.toThrow("goal changed");
  await pi.emit("input", { source: "interactive", text: "Pause this goal" }, ctx);
  const final = pi.entries.at(-1).data.goal;
  await pi.emit("session_shutdown", {}, ctx);
  await expect(pi.tools.get("reconcile_goal").execute("shutdown", { ...goalIdentifiers(final), action: "pause" }, undefined, undefined, ctx)).rejects.toThrow("session changed");
});

test("a cancelled goal can be explicitly paused then cleared without deleting history", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  await pi.commands.get("goal").handler("Objective to cancel", ctx);
  await pi.emit("input", { source: "interactive", text: "Cancel and clear this goal" }, ctx);
  const pending = pi.entries.at(-1).data.goal;
  const identifiers = goalIdentifiers(pending);
  await expect(pi.tools.get("clear_goal").execute("active", identifiers, undefined, undefined, ctx)).rejects.toThrow("inactive unfinished");
  await pi.tools.get("reconcile_goal").execute("pause", { ...identifiers, action: "pause" }, undefined, undefined, ctx);
  await pi.tools.get("clear_goal").execute("clear", identifiers, undefined, undefined, ctx);
  expect(pi.entries.at(-1).data.goal).toBeNull();
  expect(pi.entries.some((entry) => entry.data.goal?.objective === "Objective to cancel")).toBe(true);
  await pi.emit("agent_settled", {}, ctx);
  await Bun.sleep(40);
  expect(pi.sent).toHaveLength(0);
  await pi.emit("session_tree", {}, ctx);
  const result = await pi.tools.get("get_goal").execute("get", {}, undefined, undefined, ctx);
  expect(JSON.parse(result.content[0].text)).toEqual({ goal: null });
  await pi.emit("session_shutdown", {}, ctx);
});

test("inactive status questions keep the goal inactive while resume and full revision preserve accounting", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);
  const original = { ...createGoal("The complete feature", { now: 10, tokenBudget: 50_000 }), status: "paused", turns: 4, continuations: 2, tokensUsed: 1200, timeUsedMs: 35_000 };
  pi.appendEntry("goal-state", { version: 2, goal: original });
  await pi.emit("session_start", {}, ctx);
  await pi.emit("input", { source: "interactive", text: "What is the status?" }, ctx);
  await pi.tools.get("reconcile_goal").execute("keep", { ...goalIdentifiers(pi.entries.at(-1).data.goal), action: "keep" }, undefined, undefined, ctx);
  await pi.emit("agent_settled", {}, ctx);
  expect(pi.entries.at(-1).data.goal.status).toBe("paused");
  await Bun.sleep(40);
  expect(pi.sent).toHaveLength(0);
  await pi.emit("input", { source: "interactive", text: "Resume and add migrations" }, ctx);
  await pi.emit("agent_start", {}, ctx);
  const identifiers = goalIdentifiers(pi.entries.at(-1).data.goal);
  await pi.tools.get("resume_goal").execute("resume", identifiers, undefined, undefined, ctx);
  await pi.tools.get("reconcile_goal").execute("revise", {
    ...identifiers, action: "revise", objective: "The complete feature, with migrations",
    checks: [{ content: "Implement feature and migration", status: "in_progress" }, { content: "Verify every behavior", status: "pending" }],
  }, undefined, undefined, ctx);
  const revised = pi.entries.at(-1).data.goal;
  expect(revised.id).toBe(original.id);
  expect(revised.createdAt).toBe(original.createdAt);
  expect(revised.tokensUsed).toBe(original.tokensUsed);
  expect(revised.timeUsedMs).toBe(original.timeUsedMs);
  expect(revised.continuations).toBe(original.continuations);
  expect(revised.turns).toBe(original.turns + 1);
  expect(revised.tokenBudget).toBe(original.tokenBudget);
  expect(revised.objective).toContain("with migrations");
  expect(revised.checks).toHaveLength(2);
  await pi.emit("session_shutdown", {}, ctx);
});

test("provider failures preserve unresolved user scope and prevent silent automatic continuation", async () => {
  for (const errorMessage of ["WebSocket error", "Usage limit exceeded"]) {
    const pi = new MockPi();
    const ctx = mockContext(pi);
    goalExtension(pi as any);
    await pi.emit("session_start", {}, ctx);
    await pi.commands.get("goal").handler("Implement all requested changes", ctx);
    await pi.emit("input", { source: "interactive", text: "Also cover migration behavior" }, ctx);
    const pending = pi.entries.at(-1).data.goal.reconciliation;
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("message_end", { message: { ...assistantMessage(9), stopReason: "error", errorMessage } }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    expect(pi.entries.at(-1).data.goal.reconciliation).toEqual(pending);
    expect(pi.entries.at(-1).data.goal.status).toBe(errorMessage.includes("Usage") ? "usage_limited" : "stalled");
    expect(ctx.notifications.some((message) => message.includes("reconciliation is still pending"))).toBe(true);
    await Bun.sleep(40);
    expect(pi.sent).toHaveLength(0);
    await pi.emit("session_shutdown", {}, ctx);
  }
});

test("budget wrap-up may verify completed work but a later run cannot silently reactivate it", async () => {
  const pi = new MockPi();
  const ctx = mockContext(pi);
  goalExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  await pi.emit("agent_start", {}, ctx);
  await pi.tools.get("create_goal").execute("create", { objective: "Verify the already completed change", token_budget: 10 }, undefined, undefined, ctx);
  await pi.emit("message_end", { message: assistantMessage(10) }, ctx);
  expect(pi.entries.at(-1).data.goal.status).toBe("budget_limited");
  await pi.tools.get("update_goal").execute("complete", { status: "complete" }, undefined, undefined, ctx);
  expect(pi.entries.at(-1).data.goal.status).toBe("complete");
  await pi.emit("agent_settled", {}, ctx);
  await pi.emit("session_shutdown", {}, ctx);

  const stopped = new MockPi();
  const stoppedContext = mockContext(stopped);
  goalExtension(stopped as any);
  stopped.appendEntry("goal-state", { version: 2, goal: { ...createGoal("Unfinished scope", { tokenBudget: 10 }), status: "budget_limited", tokensUsed: 10 } });
  await stopped.emit("session_start", {}, stoppedContext);
  await expect(stopped.tools.get("update_goal").execute("complete", { status: "complete" }, undefined, undefined, stoppedContext)).rejects.toThrow("current budget-limited wrap-up");
  await stopped.commands.get("goal").handler("resume", stoppedContext);
  expect(stopped.entries.at(-1).data.goal.status).toBe("budget_limited");
  await stopped.emit("session_shutdown", {}, stoppedContext);
});
