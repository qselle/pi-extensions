import { expect, mock, test } from "bun:test";

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
  wrapTextWithAnsi: (value: string, width: number) => value.length <= width ? [value] : [value.slice(0, width), value.slice(width)],
  sliceByColumn: (value: string, start: number, width: number) => value.slice(start, start + width),
}));

const { default: overlayStackExtension, OverlayStackView, registerOverlayCard } = await import("./index.ts");

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
  strikethrough: (value: string) => value,
} as any;

class MockPi {
  handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  eventHandlers = new Map<string, Set<(event: unknown) => void>>();
  commands = new Map<string, any>();
  shortcuts = new Map<string, any>();
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

  on(name: string, handler: (event: any, ctx: any) => any) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  registerShortcut(key: string, shortcut: any) { this.shortcuts.set(key, shortcut); }
  async emit(name: string, event: unknown, ctx: any) {
    for (const handler of this.handlers.get(name) ?? []) await handler(event, ctx);
  }
}

test("composes independent cards in a persistent non-capturing overlay", async () => {
  const goal = registerOverlayCard({
    id: "test-goal",
    order: 5,
    minTerminalWidth: 72,
    visible: () => true,
    title: () => " Goal active ",
    renderBody: () => ["Durable objective", "1/2 validation"],
  });
  const plan = registerOverlayCard({
    id: "test-plan",
    order: 10,
    visible: () => true,
    title: () => " Plan 1/3 ",
    renderBody: () => ["● Implement overlay", "○ Verify behavior"],
  });

  const pi = new MockPi();
  overlayStackExtension(pi as any);
  let widget: any;
  let overlay: any;
  let options: any;
  let renders = 0;
  const hidden: boolean[] = [];
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      notify: (message: string) => notifications.push(message),
      setWidget: (_key: string, value: any) => {
        if (value === undefined) widget?.dispose?.();
        else widget = value;
      },
    },
  };

  await pi.emit("session_start", { reason: "startup" }, ctx);
  const tui = {
    terminal: { columns: 120, rows: 40 },
    showOverlay(component: unknown, overlayOptions: unknown) {
      overlay = component;
      options = overlayOptions;
      return { setHidden: (value: boolean) => hidden.push(value), hide: () => hidden.push(true) };
    },
    requestRender() { renders += 1; },
  };
  const host = widget(tui, theme);

  expect(options.anchor).toBe("top-right");
  expect(options.nonCapturing).toBe(true);
  expect(options.visible(120, 40)).toBe(true);
  const lines = overlay.render(options.width);
  expect(lines.join("\n")).toContain("Goal active");
  expect(lines.join("\n")).toContain("Plan 1/3");
  expect(lines.findIndex((line: string) => line.includes("Goal active")))
    .toBeLessThan(lines.findIndex((line: string) => line.includes("Plan 1/3")));
  expect(lines.every((line: string) => line.length <= options.width)).toBe(true);
  expect(host.render(120)).toEqual([]);
  tui.terminal.columns = 60;
  expect(host.render(60).join("\n")).toContain("Durable objective");

  pi.shortcuts.get("ctrl+shift+o").handler(ctx);
  expect(hidden.at(-1)).toBe(true);
  expect(host.render(60)).toEqual([]);
  pi.shortcuts.get("ctrl+shift+o").handler(ctx);
  expect(hidden.at(-1)).toBe(false);
  expect(host.render(60).join("\n")).toContain("Durable objective");

  pi.events.emit("workflow-overlay:modal", { id: "test", open: true });
  expect(hidden.at(-1)).toBe(true);
  expect(host.render(60)).toEqual([]);
  pi.events.emit("workflow-overlay:modal", { id: "test", open: false });
  expect(hidden.at(-1)).toBe(false);

  await pi.commands.get("overlay").handler("hide", ctx);
  expect(hidden.at(-1)).toBe(true);
  expect(notifications.at(-1)).toContain("hidden");
  const rendersAfterHide = renders;
  goal.invalidate();
  plan.invalidate();
  expect(renders).toBe(rendersAfterHide);
  await pi.commands.get("overlay").handler("show", ctx);
  expect(hidden.at(-1)).toBe(false);
  expect(renders).toBe(rendersAfterHide + 1);

  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  host.dispose();
  expect(host.render(60)).toEqual([]);
  goal.unregister();
  plan.unregister();
});

test("omits lower-priority cards that cannot fit the terminal", () => {
  const first = registerOverlayCard({
    id: "height-first",
    order: 1,
    visible: () => true,
    minBodyHeight: 4,
    title: () => " First ",
    renderBody: () => ["1", "2", "3", "4"],
  });
  const second = registerOverlayCard({
    id: "height-second",
    order: 2,
    visible: () => true,
    minBodyHeight: 4,
    title: () => " Second ",
    renderBody: () => ["1", "2", "3", "4"],
  });
  const view = new OverlayStackView(theme);
  view.setViewport(100, 10);
  const output = view.render(58).join("\n");
  expect(output).toContain("First");
  expect(output).not.toContain("Second");
  expect(view.renderCompact(58).join("\n")).toContain("Second");
  first.unregister();
  second.unregister();
});

test("an inline workflow stays out of the overlay and switches presentation without duplication", () => {
  let presentation: "line" | "card" = "line";
  const handle = registerOverlayCard({
    id: "inline-plan", order: 1, visible: () => true, width: 48,
    presentation: () => presentation,
    title: () => "Plan", renderBody: () => ["Current", "Next"],
    renderSummary: () => "Plan · Current",
  });
  try {
    const view = new OverlayStackView(theme);
    view.setViewport(120, 60);
    expect(view.canRender()).toBe(false);
    expect(view.render(48)).toEqual([]);
    expect(view.renderCompact(120)).toEqual(["Plan · Current"]);
    presentation = "card";
    expect(view.canRender()).toBe(true);
    expect(view.preferredWidth()).toBe(48);
    expect(view.render(48).join("\n")).toContain("Next");
    expect(view.renderCompact(120)).toEqual([]);
  } finally {
    handle.unregister();
  }
});

test("large cards share available rows and reclaim space from short cards", () => {
  const handles = ["A", "B", "C"].map((id, order) => registerOverlayCard({
    id: `fair-${id}`, order, visible: () => true, title: () => id,
    renderBody: (_width, rows) => Array.from({ length: id === "B" ? 1 : rows }, (_, i) => `${id}${i}`),
  }));
  try {
    const view = new OverlayStackView(theme);
    view.setViewport(100, 30); // 24 rows: 8 frame/spacing rows and 16 body rows.
    const lines = view.render(40);
    expect(lines.length).toBe(24);
    const count = (id: string) => lines.filter((line) => line.includes(` ${id}`)).length;
    expect(count("A")).toBe(8);
    expect(count("B")).toBe(1);
    expect(count("C")).toBe(7);
  } finally { for (const handle of handles) handle.unregister(); }
});

test("narrow viewports retain active workflow summaries without duplicating fitting cards", () => {
  const handles = [
    registerOverlayCard({ id: "compact-plan", order: 10, minTerminalWidth: 72, minTerminalHeight: 12,
      visible: () => true, title: () => "Plan 1/3", renderBody: (_width, rows) => { expect(rows).toBe(1); return ["● Active task"]; } }),
    registerOverlayCard({ id: "compact-jobs", order: 40, minTerminalWidth: 90, minTerminalHeight: 12,
      visible: () => true, title: () => "Jobs", renderBody: () => ["● Running build"] }),
  ];
  try {
    const view = new OverlayStackView(theme);
    view.setViewport(60, 28);
    expect(view.renderCompact(60).join("\n")).toContain("Active task");
    expect(view.renderCompact(60).join("\n")).toContain("Running build");
    view.setViewport(80, 28);
    expect(view.renderCompact(80).join("\n")).not.toContain("Plan");
    expect(view.renderCompact(80).join("\n")).toContain("Jobs");
    view.setViewport(100, 28);
    expect(view.renderCompact(100)).toEqual([]);
    view.setViewport(60, 10);
    const short = view.renderCompact(60);
    expect(short).toHaveLength(1);
    expect(short[0]).toContain("Active task");
    expect(short[0]).toContain("+1");
    for (const width of [0, 1, 2, 8, 12, 40]) expect(view.renderCompact(width).every((line) => line.length <= width)).toBe(true);
    view.setViewport(60, 8);
    expect(view.renderCompact(60)).toEqual([]);
  } finally { for (const handle of handles) handle.unregister(); }
});
