import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-ai", () => ({
  StringEnum: (values: readonly string[]) => ({ type: "string", enum: values }),
}));

mock.module("typebox", () => ({
  Type: {
    Object: (properties: unknown) => ({ type: "object", properties }),
    String: (options?: unknown) => ({ type: "string", ...options as object }),
    Boolean: (options?: unknown) => ({ type: "boolean", ...options as object }),
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
const { PlanOverlayCard, PlanPanel, PlanToolResult, renderPlanSummary, renderPlanText } = await import("./ui.ts");

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
  expect(rendered).not.toContain("Plan 1/3");
  expect(overlay.renderCompact(120).join("\n")).toContain("Plan 1/3 · ● Implement extension");

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

test("step descriptions follow selection and expand without making the receipt verbose", () => {
  const description = "Check reload, cancellation and restored branches.";
  const plan = replacePlan(createPlanState(), [
    { step: "Implement", status: "completed", description: "Keep the existing API." },
    { step: "Verify", status: "in_progress", description },
  ]);
  const panel = new PlanPanel(plan, plainTheme, () => {});
  expect(panel.render(80).join("\n")).toContain(description);
  panel.handleInput("up");
  expect(panel.render(80).join("\n")).toContain("Keep the existing API.");
  expect(panel.render(80).join("\n")).not.toContain(description);
  expect(new PlanToolResult(plan, plainTheme).render(80)).toHaveLength(1);
  expect(renderPlanSummary(plan, 80, plainTheme)).not.toContain(description);
  expect(new PlanToolResult(plan, plainTheme, true).render(80).join("\n")).toContain(description);
  expect(renderPlanText(plan)).toContain(description);
  const long = replacePlan(plan, plan.items.map((item) => ({ ...item, description: "Verification detail. ".repeat(28) })));
  for (const width of [0, 1, 2, 24, 40, 80]) {
    for (const height of [5, 10, 15, 30]) {
      const lines = new PlanPanel(long, plainTheme, () => {}, () => {}, () => height).render(width);
      expect(lines.length).toBeLessThanOrEqual(Math.floor(height * .8));
      expect(lines.every((line: string) => line.length <= width)).toBe(true);
    }
    expect(new PlanToolResult(long, plainTheme, true).render(width).every((line: string) => line.length <= width)).toBe(true);
  }
  expect(new PlanPanel(long, plainTheme, () => {}).render(40).join("\n")).toContain("More details: /plan status");
});

test("nested plans persist as version two and restore branch-local leaf progress", async () => {
  const { pi, ctx } = harness();
  await pi.emit("session_start", {}, ctx);
  await pi.tools.get("update_plan").execute("nested", { plan: [{ step: "Build", children: [{ step: "Implement", status: "completed" }, { step: "Verify", status: "in_progress" }] }] });
  expect(pi.entries.at(-1).data.version).toBe(2);
  expect(pi.entries.at(-1).data.plan.items[0].status).toBe("in_progress");
  const branch = [...pi.entries];
  await pi.emit("session_tree", {}, { ...ctx, sessionManager: { getBranch: () => [] } });
  const [empty] = await pi.emit("context", { messages: [] }, ctx);
  expect(empty).toBeUndefined();
  await pi.emit("session_tree", {}, { ...ctx, sessionManager: { getBranch: () => branch } });
  const [restored] = await pi.emit("context", { messages: [] }, ctx);
  expect(restored.messages[0].content).toContain("1/2 finalized");
  expect(restored.messages[0].content).toContain("  - [>] Verify");
  await pi.emit("session_shutdown", {}, ctx);
});

test("a late clear confirmation cannot remove a replaced plan", async () => {
  const { pi, ctx } = harness();
  const update = pi.tools.get("update_plan");
  await update.execute("initial", activePlan);
  let answer!: (value: boolean) => void;
  ctx.ui.confirm = () => new Promise<boolean>((resolve) => { answer = resolve; });
  const clearing = pi.commands.get("plan").handler("clear", ctx);
  await update.execute("new", { plan: [{ step: "New work", status: "in_progress" }], reset: true, explanation: "The user requested a different objective" });
  answer(true); await clearing;
  expect(pi.entries.at(-1).data.plan.items[0].step).toBe("New work");
  await pi.emit("session_shutdown", {}, ctx);
});

test("plan display defaults to one line and restores compact, card, and hidden choices per branch", async () => {
  const { pi, ctx } = harness();
  const overlay = new OverlayStackView(plainTheme);
  overlay.setViewport(120, 80);
  const command = pi.commands.get("plan");
  try {
    await pi.emit("session_start", {}, ctx);
    await pi.tools.get("update_plan").execute("plan", activePlan);
    const initial = [...pi.entries];
    expect(overlay.render(48)).toEqual([]);
    expect(overlay.renderCompact(120)).toHaveLength(1);
    expect(overlay.renderCompact(120)[0]).toContain("Implement extension");

    await command.handler("card", ctx);
    const cardBranch = [...pi.entries];
    expect(overlay.preferredWidth()).toBe(48);
    expect(overlay.render(48).join("\n")).toContain("Next  Verify integration");
    expect(overlay.render(48).length).toBeLessThanOrEqual(5);
    expect(overlay.renderCompact(120)).toEqual([]);

    await command.handler("hide", ctx);
    const hiddenBranch = [...pi.entries];
    expect(overlay.render(48)).toEqual([]);
    expect(overlay.renderCompact(120)).toEqual([]);
    const [context] = await pi.emit("context", { messages: [] }, ctx);
    expect(context.messages[0].content).toContain("Implement extension");
    await command.handler("", ctx);
    expect(pi.entries).toHaveLength(hiddenBranch.length);

    await pi.emit("session_tree", {}, { ...ctx, sessionManager: { getBranch: () => cardBranch } });
    expect(overlay.render(48).join("\n")).toContain("Plan 1/3");
    await pi.emit("session_start", {}, { ...ctx, sessionManager: { getBranch: () => hiddenBranch } });
    expect(overlay.renderCompact(120)).toEqual([]);
    expect(overlay.render(48)).toEqual([]);
    await pi.emit("session_tree", {}, { ...ctx, sessionManager: { getBranch: () => initial } });
    expect(overlay.renderCompact(120)).toHaveLength(1);

    await command.handler("compact", ctx);
    expect(pi.entries.at(-1)).toMatchObject({ customType: "plan-view", data: { version: 1, view: "compact" } });
    await pi.tools.get("update_plan").execute("finished", { plan: activePlan.plan.map((item) => ({ ...item, status: "completed" })) });
    expect(overlay.renderCompact(120)).toEqual([]);
  } finally {
    await pi.emit("session_shutdown", {}, ctx);
  }
});

test("malformed display entries keep the default and failed saves do not change the display", async () => {
  const { pi, ctx } = harness();
  const overlay = new OverlayStackView(plainTheme);
  overlay.setViewport(100, 30);
  try {
    await pi.tools.get("update_plan").execute("plan", activePlan);
    for (const data of [null, "hide", { version: 2, view: "hide" }, { version: 1, view: "unknown" }]) {
      pi.entries.push({ type: "custom", customType: "plan-view", data });
    }
    await pi.emit("session_start", {}, ctx);
    expect(overlay.renderCompact(100)).toHaveLength(1);
    pi.appendEntry = () => { throw new Error("save failed"); };
    await expect(pi.commands.get("plan").handler("hide", ctx)).rejects.toThrow("save failed");
    expect(overlay.renderCompact(100)).toHaveLength(1);
  } finally {
    await pi.emit("session_shutdown", {}, ctx);
  }
});

test("rejected replacements preserve saved state and user clear allows a new plan", async () => {
  const { pi, ctx, notifications } = harness();
  const update = pi.tools.get("update_plan");
  try {
    await pi.emit("session_start", {}, ctx);
    await update.execute("initial", activePlan);
    const snapshot = JSON.stringify(pi.entries);
    const newWork = { plan: [{ step: "New work", status: "in_progress" }] };
    await expect(update.execute("narrowed", newWork)).rejects.toThrow("Keep completed milestones");
    await expect(update.execute("missing reason", { ...newWork, reset: true })).rejects.toThrow("requires an explanation");
    expect(JSON.stringify(pi.entries)).toBe(snapshot);
    ctx.ui.confirm = async () => false;
    await pi.commands.get("plan").handler("clear", ctx);
    await expect(update.execute("still guarded", newWork)).rejects.toThrow("Keep completed milestones");
    ctx.ui.confirm = async () => true;
    await pi.commands.get("plan").handler("clear", ctx);
    expect(notifications.at(-1)).toBe("Plan cleared.");
    await update.execute("new objective", newWork);
    expect(pi.entries.at(-1).data.plan.items).toEqual(newWork.plan);
    expect(pi.entries[0].data.plan.items[0].step).toBe("Research behavior");
  } finally { await pi.emit("session_shutdown", {}, ctx); }
});

test("continuity follows restored branch state and an explicit reset remains append-only", async () => {
  const { pi, ctx } = harness();
  const update = pi.tools.get("update_plan");
  try {
    await update.execute("initial", activePlan);
    const originalBranch = [...pi.entries];
    await update.execute("later", { plan: activePlan.plan.map((item, index) => ({ ...item, status: index < 2 ? "completed" : "in_progress" })) });
    await expect(update.execute("drop later milestone", activePlan)).rejects.toThrow("Implement extension");
    await pi.emit("session_tree", {}, { ...ctx, sessionManager: { getBranch: () => JSON.parse(JSON.stringify(originalBranch)) } });
    await update.execute("old branch", activePlan);
    await expect(update.execute("drop restored milestone", { plan: activePlan.plan.slice(1) })).rejects.toThrow("Research behavior");
    await update.execute("changed objective", {
      reset: true, explanation: "User requested the documentation project instead",
      plan: [{ step: "Write documentation", status: "in_progress" }],
    });
    expect(pi.entries.at(-1).data.plan.explanation).toContain("documentation project");
    expect(pi.entries[0].data.plan.items[0].step).toBe("Research behavior");
  } finally { await pi.emit("session_shutdown", {}, ctx); }
});
