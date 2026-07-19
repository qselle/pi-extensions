import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-ai", () => ({
  StringEnum: (values: readonly string[]) => ({ type: "string", enum: values }),
}));

mock.module("typebox", () => ({
  Type: {
    Object: (properties: unknown) => ({ type: "object", properties }),
    String: (options?: unknown) => ({ type: "string", ...options as object }),
    Array: (items: unknown, options?: unknown) => ({ type: "array", items, ...options as object }),
    Optional: (schema: unknown) => schema,
    Integer: (options?: unknown) => ({ type: "integer", ...options as object }),
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
  truncateToWidth: (value: string, width: number) => value.length <= width ? value : value.slice(0, width),
  visibleWidth: (value: string) => value.length,
  sliceByColumn: (value: string, start: number, width: number) => value.slice(start, start + width),
  wrapTextWithAnsi: (value: string, width: number) => {
    if (value.length <= width) return [value];
    const lines = [];
    for (let index = 0; index < value.length; index += width) lines.push(value.slice(index, index + width));
    return lines;
  },
}));

const { default: planExtension } = await import("./index.ts");
const { default: goalExtension } = await import("../goal/index.ts");
const { OverlayStackView } = await import("../overlay-stack/index.ts");
const { createPlanState, replacePlan } = await import("./plan.ts");
const { PlanOverlayCard, PlanPanel } = await import("./ui.ts");

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
  sendMessage(message: unknown, options: unknown) { this.sent.push({ message, options }); }
  async emit(event: string, payload: unknown, ctx: any) {
    const results = [];
    for (const handler of this.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  }
}

function harness() {
  const pi = new MockPi();
  const notifications: string[] = [];
  const widgetFactories = new Map<string, unknown>();
  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => pi.entries },
    ui: {
      notify: (message: string) => notifications.push(message),
      setWidget: (key: string, value: unknown) => widgetFactories.set(key, value),
      confirm: async () => true,
      editor: async () => undefined,
      custom: async () => "close",
      theme: plainTheme,
    },
  };
  planExtension(pi as any);
  return { pi, ctx, notifications, widgetFactories };
}

const plainTheme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
  strikethrough: (value: string) => value,
} as any;

const activePlan = {
  explanation: "Implementing the selected design",
  plan: [
    { step: "Research behavior", status: "completed" },
    { step: "Implement extension", status: "in_progress" },
    { step: "Verify integration", status: "pending" },
  ],
};

test("persists full replacements and injects plan context transiently", async () => {
  const { pi, ctx } = harness();
  await pi.emit("session_start", { reason: "startup" }, ctx);
  const update = pi.tools.get("update_plan");
  const result = await update.execute("plan-1", activePlan, undefined, undefined, ctx);

  expect(pi.entries.at(-1).customType).toBe("plan-state");
  expect(pi.entries.at(-1).data.version).toBe(1);
  expect(pi.entries.at(-1).data.plan.items[1].status).toBe("in_progress");
  expect(result.content[0].text).toContain("Current: Implement extension");

  const [contextResult] = await pi.emit("context", {
    messages: [
      { role: "custom", customType: "plan-context", content: "stale", timestamp: 1 },
      { role: "user", content: "continue", timestamp: 2 },
    ],
  }, ctx);
  expect(contextResult.messages).toHaveLength(2);
  expect(contextResult.messages[0].role).toBe("user");
  expect(contextResult.messages[1].customType).toBe("plan-context");
  expect(contextResult.messages[1].content).toContain("Implement extension");
  expect(pi.entries.some((entry) => JSON.stringify(entry).includes("Active execution plan"))).toBe(false);

  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("completed plans disappear from provider context but remain restorable", async () => {
  const { pi, ctx, notifications } = harness();
  await pi.emit("session_start", { reason: "startup" }, ctx);
  const update = pi.tools.get("update_plan");
  await update.execute("plan-1", activePlan, undefined, undefined, ctx);
  await update.execute("plan-2", {
    explanation: "All work verified",
    plan: activePlan.plan.map((item) => ({ ...item, status: "completed" })),
  }, undefined, undefined, ctx);

  const [contextResult] = await pi.emit("context", {
    messages: [{ role: "custom", customType: "plan-context", content: "stale", timestamp: 1 }],
  }, ctx);
  expect(contextResult.messages).toEqual([]);

  await pi.emit("session_tree", {}, ctx);
  await pi.commands.get("plan").handler("status", ctx);
  expect(notifications.at(-1)).toContain("All work verified");
  expect(notifications.at(-1)).toContain("✓ Verify integration");
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("keeps durable goal checks separate from the tactical plan", async () => {
  const { pi, ctx, notifications } = harness();
  ctx.mode = "rpc";
  goalExtension(pi as any);
  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.commands.get("goal").handler("Ship a verified release", ctx);
  await pi.tools.get("update_plan").execute("plan-1", activePlan, undefined, undefined, ctx);
  await pi.tools.get("report_goal_progress").execute("goal-progress", {
    checks: [
      { content: "Acceptance suite proves release behavior", status: "in_progress" },
      { content: "Release artifact is published", status: "pending" },
    ],
    summary: "Validation is independent from implementation steps",
  }, undefined, undefined, ctx);

  await pi.commands.get("plan").handler("status", ctx);
  expect(notifications.at(-1)).toContain("Implement extension");
  expect(notifications.at(-1)).not.toContain("Acceptance suite");

  const result = await pi.tools.get("get_goal").execute("goal", {}, undefined, undefined, ctx);
  const activeGoal = JSON.parse(result.content[0].text).goal;
  expect(activeGoal.checks[0].content).toContain("Acceptance suite");
  expect(activeGoal.checks.some((check: any) => check.content === "Implement extension")).toBe(false);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("coexists with goal context during an automatic goal run", async () => {
  const { pi, ctx } = harness();
  ctx.mode = "rpc";
  goalExtension(pi as any);
  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.commands.get("goal").handler("Ship a multi-step integrated feature", ctx);
  await pi.tools.get("update_plan").execute("plan-1", activePlan, undefined, undefined, ctx);

  const beforeResults = await pi.emit("before_agent_start", {}, ctx);
  const goalMarker = beforeResults.find((result) => result?.message)?.message;
  expect(goalMarker?.customType).toBe("goal-context");
  await pi.emit("agent_start", {}, ctx);

  let event = {
    messages: [
      { role: "user", content: "continue", timestamp: 1 },
      { role: "custom", ...goalMarker, timestamp: 2 },
    ],
  };
  for (const handler of pi.handlers.get("context") ?? []) {
    const result = await handler(event, ctx);
    if (result?.messages) event = result;
  }

  const goalContext = event.messages.find((message: any) => message.customType === "goal-context");
  const planContext = event.messages.find((message: any) => message.customType === "plan-context");
  expect(goalContext?.content).toContain("Ship a multi-step integrated feature");
  expect(goalContext?.content).toContain("If update_plan is available");
  expect(planContext?.content).toContain("Implement extension");

  const overlay = new OverlayStackView(plainTheme);
  overlay.setViewport(120, 40);
  const rendered = overlay.render(58).join("\n");
  expect(rendered).toContain("Goal ● ACTIVE");
  expect(rendered).toContain("Plan 1/3");
  expect(rendered.indexOf("Goal ● ACTIVE")).toBeLessThan(rendered.indexOf("Plan 1/3"));

  await pi.emit("tool_execution_end", {}, ctx);
  await pi.emit("agent_settled", {}, ctx);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("keeps the card and full panel inside responsive widths", () => {
  const plan = replacePlan(createPlanState(), activePlan.plan as any, activePlan.explanation);
  for (const width of [24, 40, 54, 72]) {
    const card = new PlanOverlayCard(plainTheme, () => plan);
    expect(card.render(width).every((line: string) => line.length <= width)).toBe(true);
  }
  for (const width of [32, 44, 72]) {
    const panel = new PlanPanel(plan, plainTheme, () => {});
    expect(panel.render(width).every((line: string) => line.length <= width)).toBe(true);
  }
});
