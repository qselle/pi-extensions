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
  truncateToWidth: (value: string, width: number) => value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`,
  visibleWidth: (value: string) => value.length,
  wrapTextWithAnsi: (value: string) => [value],
  sliceByColumn: (value: string, start: number, width: number) => value.slice(start, start + width),
}));

const { CatPanel, parseCatCommand } = await import("./panel.ts");
const { default: catExtension } = await import("./index.ts");

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
  strikethrough: (value: string) => value,
} as any;

test("parses interactive, visibility, and animation commands", () => {
  expect(parseCatCommand("")).toEqual({ type: "panel" });
  expect(parseCatCommand(" STATUS ")).toEqual({ type: "status" });
  expect(parseCatCommand("on")).toEqual({ type: "visibility", visible: true });
  expect(parseCatCommand("hide")).toEqual({ type: "visibility", visible: false });
  expect(parseCatCommand("smart")).toEqual({ type: "mode", mode: "smart" });
  expect(parseCatCommand("working")).toEqual({ type: "mode", mode: "working" });
  expect(parseCatCommand("unknown")).toEqual({ type: "invalid" });
});

test("renders the cat control panel within narrow and wide widths", () => {
  const panel = new CatPanel(true, "smart", theme, () => {}, () => {});
  for (const width of [20, 40, 52, 80]) {
    const lines = panel.render(width);
    expect(lines.length).toBe(12);
    expect(lines.every((line: string) => line.length <= width)).toBe(true);
  }
  expect(panel.render(80).join("\n")).toContain("Occasional movement");
  expect(panel.render(40).join("\n")).not.toContain("Occasional movement");
});

test("selects visibility and animation options from the keyboard", () => {
  const visibilityActions: unknown[] = [];
  let visibilityClosed = 0;
  const visibilityPanel = new CatPanel(
    true,
    "smart",
    theme,
    () => visibilityClosed++,
    (action: unknown) => visibilityActions.push(action),
  );
  visibilityPanel.handleInput("enter");
  expect(visibilityActions).toEqual([{ type: "visibility", visible: false }]);
  expect(visibilityClosed).toBe(1);

  const modeActions: unknown[] = [];
  const modePanel = new CatPanel(false, "smart", theme, () => {}, (action: unknown) => modeActions.push(action));
  modePanel.handleInput("down");
  modePanel.handleInput("down");
  modePanel.handleInput("enter");
  expect(modeActions).toEqual([{ type: "mode", mode: "always" }]);
});

test("wraps navigation and closes without changing state", () => {
  const actions: unknown[] = [];
  let closed = 0;
  const panel = new CatPanel(true, "static", theme, () => closed++, (action: unknown) => actions.push(action));
  panel.handleInput("up");
  panel.handleInput("enter");
  expect(actions).toEqual([{ type: "mode", mode: "static" }]);

  const escapePanel = new CatPanel(true, "smart", theme, () => closed++, (action: unknown) => actions.push(action));
  escapePanel.handleInput("escape");
  expect(closed).toBe(2);
  expect(actions).toHaveLength(1);
});

test("registers Ctrl+Shift+C to toggle cat visibility", () => {
  const shortcuts = new Map<string, any>();
  const widgets: unknown[] = [];
  const notifications: string[] = [];
  const pi = {
    on() {},
    registerCommand() {},
    registerShortcut(key: string, shortcut: any) { shortcuts.set(key, shortcut); },
  };
  catExtension(pi as any);
  const ctx = {
    mode: "rpc",
    ui: {
      setWidget: (...args: unknown[]) => widgets.push(args),
      notify: (message: string) => notifications.push(message),
    },
  };

  shortcuts.get("ctrl+shift+c").handler(ctx);
  expect((widgets.at(-1) as unknown[])[1]).toBeUndefined();
  expect(notifications.at(-1)).toContain("hidden");
  shortcuts.get("ctrl+shift+c").handler(ctx);
  expect(notifications.at(-1)).toContain("visible");
});
