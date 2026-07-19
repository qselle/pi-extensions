import { expect, mock, test } from "bun:test";

class MockInput {
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
}

class MockCustomEditor {
  private text = "";
  borderColor = (value: string) => value;
  constructor(..._args: any[]) {}
  getText() { return this.text; }
  setText(text: string) { this.text = text; }
  handleInput(data: string) {
    if (data.length === 1 && data >= " ") this.text += data;
  }
  render() { return [this.text]; }
  invalidate() {}
}

mock.module("@earendil-works/pi-coding-agent", () => ({
  CustomEditor: MockCustomEditor,
  generateUnifiedPatch: (_path: string, before: string, after: string) => [
    "--- before",
    "+++ after",
    ...before.split("\n").filter(Boolean).map((line) => `-${line}`),
    ...after.split("\n").filter(Boolean).map((line) => `+${line}`),
  ].join("\n"),
  isToolCallEventType: (name: string, event: { toolName?: string }) => event.toolName === name,
  isEditToolResult: (event: { toolName?: string }) => event.toolName === "edit",
  isWriteToolResult: (event: { toolName?: string }) => event.toolName === "write",
}));

mock.module("@earendil-works/pi-tui", () => ({
  Input: MockInput,
  Text: class Text {
    constructor(public text: string) {}
    render() { return [this.text]; }
    invalidate() {}
  },
  Key: {
    ctrl: (key: string) => `ctrl+${key}`,
    escape: "escape",
    enter: "enter",
    up: "up",
    down: "down",
  },
  matchesKey: (data: string, key: string) => data === key || (data === "\x12" && key === "ctrl+r"),
  truncateToWidth: (value: string, width: number) => value.length <= width ? value : value.slice(0, width),
  visibleWidth: (value: string) => value.length,
  wrapTextWithAnsi: (value: string, width: number) => value.length <= width ? [value] : [value.slice(0, width), value.slice(width)],
  sliceByColumn: (value: string, start: number, width: number) => value.slice(start, start + width),
}));

const { HistoryPicker } = await import("./picker.ts");
const { default: historySearchExtension } = await import("./index.ts");

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
  strikethrough: (value: string) => value,
} as any;

const keybindings = {
  matches(data: string, id: string) {
    const keys: Record<string, string[]> = {
      "tui.select.cancel": ["escape", "ctrl+c"],
      "tui.select.confirm": ["enter"],
      "tui.select.up": ["up"],
      "tui.select.down": ["down"],
      "tui.select.pageUp": ["pageUp"],
      "tui.select.pageDown": ["pageDown"],
    };
    return keys[id]?.includes(data) ?? false;
  },
} as any;

const items = [
  { text: "fix login flow", source: "message" as const, recency: 0 },
  { text: "deploy production", source: "message" as const, recency: 1 },
  { text: "debug parser", source: "message" as const, recency: 2 },
];

test("filters, ranks, navigates, renders, and selects history", () => {
  const completed: Array<string | null> = [];
  let renders = 0;
  const tui = { terminal: { rows: 30 }, requestRender: () => renders++ } as any;
  const picker = new HistoryPicker(items, "", theme, keybindings, tui, (result) => completed.push(result));

  picker.focused = true;
  expect(picker.focused).toBe(true);
  picker.handleInput("d");
  picker.handleInput("e");
  picker.handleInput("p");
  expect(picker.getQuery()).toBe("dep");
  expect(picker.getMatches()[0]?.text).toBe("deploy production");

  const beforeMove = picker.getMatches().map((item: any) => item.text);
  picker.handleInput("ctrl+r");
  expect(picker.getSelectedIndex()).toBe(beforeMove.length > 1 ? 1 : 0);
  picker.handleInput("enter");
  expect(completed).toEqual([beforeMove[Math.min(1, beforeMove.length - 1)]]);
  expect(renders).toBeGreaterThan(0);

  for (const width of [20, 44, 80]) {
    const lines = picker.render(width);
    expect(lines.join("\n")).toContain("History");
    expect(lines.every((line: string) => line.length <= width)).toBe(true);
  }
});

test("cancels without selecting and resets selection after query edits", () => {
  const completed: Array<string | null> = [];
  const tui = { terminal: { rows: 24 }, requestRender() {} } as any;
  const picker = new HistoryPicker(items, "", theme, keybindings, tui, (result) => completed.push(result));
  picker.handleInput("down");
  expect(picker.getSelectedIndex()).toBe(1);
  picker.handleInput("f");
  expect(picker.getSelectedIndex()).toBe(0);
  picker.handleInput("escape");
  expect(completed).toEqual([null]);
});

class MockPi {
  handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  commands = new Map<string, any>();
  shortcuts = new Map<string, any>();
  emitted: Array<{ name: string; event: unknown }> = [];
  events = { emit: (name: string, event: unknown) => this.emitted.push({ name, event }) };
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  registerShortcut(key: string, shortcut: any) { this.shortcuts.set(key, shortcut); }
  on(name: string, handler: (event: any, ctx: any) => any) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }
  async emit(name: string, event: unknown, ctx: any) {
    for (const handler of this.handlers.get(name) ?? []) await handler(event, ctx);
  }
}

test("Ctrl+R opens a focused overlay without registering a conflicting shortcut", async () => {
  const pi = new MockPi();
  historySearchExtension(pi as any);
  let component: any;
  let overlayOptions: any;
  let currentFactory: any;
  const editorUpdates: string[] = [];
  const ctx = {
    mode: "tui",
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "user", content: "older prompt" } },
        { type: "message", message: { role: "user", content: "newer prompt" } },
      ],
    },
    ui: {
      getEditorComponent: () => currentFactory,
      setEditorComponent: (factory: any) => { currentFactory = factory; },
      getEditorText: () => "",
      setEditorText: (text: string) => editorUpdates.push(text),
      notify() {},
      custom: async (factory: any, options: any) => {
        overlayOptions = options;
        component = factory(
          { terminal: { rows: 30 }, requestRender() {} },
          theme,
          keybindings,
          () => {},
        );
        return "older prompt";
      },
    },
  };

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.emit("input", { source: "interactive", text: "current process prompt" }, ctx);
  const editor = currentFactory({ requestRender() {} }, theme, keybindings);
  editor.handleInput("\x12");
  await Promise.resolve();
  await Promise.resolve();

  expect(pi.shortcuts.size).toBe(0);
  expect(overlayOptions.overlay).toBe(true);
  expect(overlayOptions.overlayOptions.anchor).toBe("center");
  expect(component.getQuery()).toBe("");
  expect(component.getMatches().some((item: any) => item.text === "current process prompt")).toBe(true);
  expect(editorUpdates).toEqual(["older prompt"]);
  expect(pi.emitted.map((entry) => entry.event)).toEqual([
    { id: "history-search", open: true },
    { id: "history-search", open: false },
  ]);
  expect(pi.commands.has("history-search")).toBe(true);
});

test("cancelling preserves the existing editor draft and shutdown restores the previous editor", async () => {
  const pi = new MockPi();
  historySearchExtension(pi as any);
  const updates: string[] = [];
  const previousFactory = (...args: any[]) => new MockCustomEditor(...args);
  let currentFactory: any = previousFactory;
  const ctx = {
    mode: "tui",
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "history" } }] },
    ui: {
      getEditorComponent: () => currentFactory,
      setEditorComponent: (factory: any) => { currentFactory = factory; },
      getEditorText: () => "unfinished draft",
      setEditorText: (text: string) => updates.push(text),
      notify() {},
      custom: async () => null,
    },
  };

  await pi.emit("session_start", { reason: "startup" }, ctx);
  const installedFactory = currentFactory;
  const editor = installedFactory({ requestRender() {} }, theme, keybindings);
  editor.handleInput("\x12");
  await Promise.resolve();
  await Promise.resolve();
  expect(updates).toEqual([]);

  await pi.emit("session_shutdown", { reason: "reload" }, ctx);
  expect(currentFactory).toBe(previousFactory);
});
