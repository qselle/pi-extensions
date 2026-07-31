import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import catExtension from "./index.ts";
import { CatPanel, parseCatCommand } from "./panel.ts";

const ENTER = "\r";
const ESCAPE = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

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
    expect(lines.every((line: string) => visibleWidth(line) <= width)).toBe(true);
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
  visibilityPanel.handleInput(ENTER);
  expect(visibilityActions).toEqual([{ type: "visibility", visible: false }]);
  expect(visibilityClosed).toBe(1);

  const modeActions: unknown[] = [];
  const modePanel = new CatPanel(false, "smart", theme, () => {}, (action: unknown) => modeActions.push(action));
  modePanel.handleInput(DOWN);
  modePanel.handleInput(DOWN);
  modePanel.handleInput(ENTER);
  expect(modeActions).toEqual([{ type: "mode", mode: "always" }]);
});

test("wraps navigation and closes without changing state", () => {
  const actions: unknown[] = [];
  let closed = 0;
  const panel = new CatPanel(true, "static", theme, () => closed++, (action: unknown) => actions.push(action));
  panel.handleInput(UP);
  panel.handleInput(ENTER);
  expect(actions).toEqual([{ type: "mode", mode: "static" }]);

  const escapePanel = new CatPanel(true, "smart", theme, () => closed++, (action: unknown) => actions.push(action));
  escapePanel.handleInput(ESCAPE);
  expect(closed).toBe(2);
  expect(actions).toHaveLength(1);
});

test("registers Ctrl+Shift+C to toggle cat visibility", () => {
  const shortcuts = new Map<string, any>();
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
      notify: (message: string) => notifications.push(message),
    },
  };

  shortcuts.get("ctrl+shift+c").handler(ctx);
  expect(notifications.at(-1)).toContain("hidden");
  shortcuts.get("ctrl+shift+c").handler(ctx);
  expect(notifications.at(-1)).toContain("visible");
});
