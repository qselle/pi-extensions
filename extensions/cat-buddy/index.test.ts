import { afterEach, expect, jest, test } from "bun:test";
import catBuddyExtension from "./index.ts";
import { CAT_FRAME_DURATION_MS } from "./frames.ts";

type Handler = (event: unknown, ctx: any) => unknown;

class MockPi {
  readonly commands = new Map<string, any>();
  readonly shortcuts = new Map<string, any>();
  readonly handlers = new Map<string, Handler[]>();

  registerCommand(name: string, command: any): void {
    this.commands.set(name, command);
  }

  registerShortcut(name: string, shortcut: any): void {
    this.shortcuts.set(name, shortcut);
  }

  on(name: string, handler: Handler): void {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }

  async emit(name: string, event: unknown, ctx: any): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) await handler(event, ctx);
  }
}

const editorTheme = {
  borderColor: (value: string) => value,
  selectList: {
    selectedPrefix: (value: string) => value,
    selectedText: (value: string) => value,
    description: (value: string) => value,
    scrollInfo: (value: string) => value,
    noMatch: (value: string) => value,
  },
};
const keybindings = { matches: () => false };

afterEach(() => {
  if (jest.isFakeTimers()) {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("docks on the current editor through Pi's public editor lifecycle", async () => {
  const pi = new MockPi();
  const notices: string[] = [];
  let colorCalls = 0;
  const baseLines = ["─".repeat(40), "  prompt", "─".repeat(40)];
  const baseEditor = {
    render: () => baseLines,
    handleInput() {},
    invalidate() {},
    getText: () => "",
    setText() {},
    borderColor: (value: string) => {
      colorCalls += 1;
      return value;
    },
  };
  const previousFactory = () => baseEditor;
  let currentFactory: any = previousFactory;
  const ctx = {
    mode: "tui",
    ui: {
      getEditorComponent: () => currentFactory,
      setEditorComponent: (factory: any) => { currentFactory = factory; },
      notify: (message: string) => notices.push(message),
    },
  };

  catBuddyExtension(pi as any);
  expect(pi.commands.has("cat")).toBe(true);
  expect(pi.shortcuts.has("ctrl+shift+c")).toBe(true);

  await pi.emit("session_start", {}, ctx);
  expect(currentFactory).not.toBe(previousFactory);
  const editor = currentFactory(
    { terminal: { rows: 24 }, requestRender() {} },
    { fg: (_color: string, value: string) => value },
    {},
  );
  const docked = editor.render(40);
  expect(docked).toHaveLength(baseLines.length + 2);
  expect(docked[0]).toContain("⡠");
  expect(colorCalls).toBe(0);
  expect(docked[0]).toContain("\x1b[38;2;254;128;25m");
  expect(docked[2]).toContain("⠈⠉");
  expect(docked[3]).toBe("  prompt");

  await pi.commands.get("cat").handler("hide", ctx);
  expect(editor.render(40)).toEqual(baseLines);
  expect(notices.at(-1)).toContain("hidden");

  await pi.commands.get("cat").handler("show", ctx);
  expect(editor.render(40)).toHaveLength(baseLines.length + 2);

  await pi.emit("session_shutdown", {}, ctx);
  expect(currentFactory).toBe(previousFactory);
});

test("quit restores the shell cursor after editor teardown", async () => {
  const pi = new MockPi();
  let cursorVisible = true;
  let cursorRestores = 0;
  const terminal = { rows: 24, showCursor() { cursorVisible = true; cursorRestores++; } };
  const tui = { terminal, requestRender() {} };
  const baseFactory = () => ({ render: () => ["─".repeat(40), "prompt", "─".repeat(40)] });
  let currentFactory: any = baseFactory;
  const ctx = { mode: "tui", ui: {
    getEditorComponent: () => currentFactory,
    setEditorComponent(factory: any) {
      currentFactory = factory;
      // Model a late teardown hiding the cursor after Pi has stopped its TUI.
      if (factory === baseFactory) cursorVisible = false;
    },
    notify() {},
  } };

  catBuddyExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  currentFactory(tui, editorTheme, keybindings).render(40);
  await pi.emit("session_shutdown", { reason: "new" }, ctx);
  expect(cursorVisible).toBe(false);
  expect(cursorRestores).toBe(0);

  await pi.emit("session_start", {}, ctx);
  currentFactory(tui, editorTheme, keybindings).render(40);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  expect(cursorVisible).toBe(true);
  expect(cursorRestores).toBe(1);
});

for (const tuiMode of ["regular", "fullscreen"] as const) {
  test(`fallback editor embeds Pi's working indicator in ${tuiMode} mode`, async () => {
    const pi = new MockPi();
    let currentFactory: any;
    const ctx = {
      mode: "tui",
      ui: {
        getEditorComponent: () => currentFactory,
        setEditorComponent: (factory: any) => { currentFactory = factory; },
        notify() {},
      },
    };

    catBuddyExtension(pi as any);
    await pi.emit("session_start", {}, ctx);
    const editor = currentFactory(
      { mode: tuiMode, terminal: { rows: 24 }, requestRender() {} },
      editorTheme,
      keybindings,
    );

    expect(editor.embedWorkingStatus).toBe(true);
    editor.setWorkingStatusIndicator({
      renderInBorder: () => "⠋ Working",
      renderSpinnerInBorder: () => "⠋",
    });
    expect(editor.render(48).some((line: string) => line.includes("Working"))).toBe(true);

    await pi.emit("session_shutdown", {}, ctx);
    expect(currentFactory).toBeUndefined();
  });
}

test("pauses smart animation while hidden without background redraws", async () => {
  jest.useFakeTimers();

  const pi = new MockPi();
  let renders = 0;
  const baseEditor = {
    render: () => ["─".repeat(40), "  prompt", "─".repeat(40)],
    handleInput() {},
    invalidate() {},
    getText: () => "",
    setText() {},
  };
  let currentFactory: any = () => baseEditor;
  const ctx = {
    mode: "tui",
    ui: {
      getEditorComponent: () => currentFactory,
      setEditorComponent: (factory: any) => { currentFactory = factory; },
      notify() {},
    },
  };

  catBuddyExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  const editor = currentFactory(
    { terminal: { rows: 24 }, requestRender: () => { renders += 1; } },
    { fg: (_color: string, value: string) => value },
    {},
  );
  const neutralPose = editor.render(40);

  await pi.emit("agent_start", {}, ctx);
  expect(jest.getTimerCount()).toBe(1);
  jest.advanceTimersByTime(CAT_FRAME_DURATION_MS);
  const interruptedPose = editor.render(40);
  expect(interruptedPose).not.toEqual(neutralPose);

  await pi.commands.get("cat").handler("hide", ctx);
  expect(jest.getTimerCount()).toBe(0);
  const rendersAfterHide = renders;
  jest.advanceTimersByTime(CAT_FRAME_DURATION_MS * 3);
  expect(renders).toBe(rendersAfterHide);

  await pi.commands.get("cat").handler("show", ctx);
  expect(jest.getTimerCount()).toBe(1);
  expect(editor.render(40)).toEqual(interruptedPose);
  const rendersAfterShow = renders;
  jest.advanceTimersByTime(CAT_FRAME_DURATION_MS);
  expect(renders).toBe(rendersAfterShow + 1);
  expect(editor.render(40)).toEqual(neutralPose);
  expect(jest.getTimerCount()).toBe(1);

  jest.advanceTimersByTime(CAT_FRAME_DURATION_MS * 2);
  expect(editor.render(40)).not.toEqual(neutralPose);
  await pi.commands.get("cat").handler("hide", ctx);
  const rendersBeforeSettlement = renders;
  await pi.emit("agent_settled", {}, ctx);
  expect(renders).toBe(rendersBeforeSettlement);
  expect(jest.getTimerCount()).toBe(0);

  await pi.commands.get("cat").handler("show", ctx);
  expect(editor.render(40)).toEqual(neutralPose);
  expect(jest.getTimerCount()).toBe(1);

  await pi.emit("session_shutdown", {}, ctx);
  expect(jest.getTimerCount()).toBe(0);
});

test("pauses animation while the terminal cannot display the cat", async () => {
  jest.useFakeTimers();

  const pi = new MockPi();
  let renders = 0;
  const terminal = { rows: 24 };
  const baseLines = ["─".repeat(40), "  prompt", "─".repeat(40)];
  const baseEditor = {
    render: () => baseLines,
    handleInput() {},
    invalidate() {},
    getText: () => "",
    setText() {},
  };
  let currentFactory: any = () => baseEditor;
  const ctx = {
    mode: "tui",
    ui: {
      getEditorComponent: () => currentFactory,
      setEditorComponent: (factory: any) => { currentFactory = factory; },
      notify() {},
    },
  };

  catBuddyExtension(pi as any);
  await pi.emit("session_start", {}, ctx);
  const editor = currentFactory(
    { terminal, requestRender: () => { renders += 1; } },
    { fg: (_color: string, value: string) => value },
    {},
  );

  expect(editor.render(30)).toEqual(baseLines);
  expect(jest.getTimerCount()).toBe(0);

  const neutralPose = editor.render(40);
  expect(jest.getTimerCount()).toBe(1);
  await pi.emit("agent_start", {}, ctx);
  jest.advanceTimersByTime(CAT_FRAME_DURATION_MS);
  const interruptedPose = editor.render(40);
  expect(interruptedPose).not.toEqual(neutralPose);

  expect(editor.render(30)).toEqual(baseLines);
  expect(jest.getTimerCount()).toBe(0);
  const rendersWhileNarrow = renders;
  jest.advanceTimersByTime(CAT_FRAME_DURATION_MS * 3);
  expect(renders).toBe(rendersWhileNarrow);

  expect(editor.render(40)).toEqual(interruptedPose);
  expect(jest.getTimerCount()).toBe(1);
  const rendersAfterWidthRestore = renders;
  jest.advanceTimersByTime(CAT_FRAME_DURATION_MS);
  expect(renders).toBe(rendersAfterWidthRestore + 1);
  expect(editor.render(40)).toEqual(neutralPose);

  terminal.rows = 9;
  expect(editor.render(40)).toEqual(baseLines);
  expect(jest.getTimerCount()).toBe(0);
  terminal.rows = 24;
  expect(editor.render(40)).toHaveLength(baseLines.length + 2);
  expect(jest.getTimerCount()).toBe(1);

  const rendersAfterResize = renders;
  jest.advanceTimersByTime(CAT_FRAME_DURATION_MS);
  expect(renders).toBe(rendersAfterResize + 1);

  await pi.emit("session_shutdown", {}, ctx);
});

function lifecycleHarness(lines: string[]) {
  const pi = new MockPi();
  let renders = 0;
  const original = () => ({ render: () => lines, handleInput() {}, invalidate() {}, getText: () => "", setText() {} });
  let factory: any = original;
  const ctx = { mode: "tui", ui: {
    getEditorComponent: () => factory,
    setEditorComponent: (next: any) => { factory = next; },
    notify() {},
  } };
  catBuddyExtension(pi as any);
  return { pi, ctx, original, factory: () => factory,
    create: () => factory({ terminal: { rows: 24 }, requestRender: () => { renders++; } }, editorTheme, keybindings),
    renders: () => renders };
}

test("repeated session starts retain one factory and reset working animation", async () => {
  jest.useFakeTimers();
  const h = lifecycleHarness(["─".repeat(40), "prompt"]);
  await h.pi.emit("session_start", {}, h.ctx);
  const installed = h.factory();
  const editor = h.create();
  editor.render(40);
  await h.pi.emit("agent_start", {}, h.ctx);
  await h.pi.emit("session_start", {}, h.ctx);
  expect(h.factory()).toBe(installed);
  expect(h.create().render(40)).toHaveLength(4);
  expect(jest.getTimerCount()).toBe(1);
  await h.pi.emit("session_shutdown", {}, h.ctx);
  expect(h.factory()).toBe(h.original);
  expect(jest.getTimerCount()).toBe(0);
});

test("old editor renders cannot animate or borrow a replacement sprite", async () => {
  jest.useFakeTimers();
  const lines = ["─".repeat(40), "prompt"];
  const h = lifecycleHarness(lines);
  await h.pi.emit("session_start", {}, h.ctx);
  const old = h.create();
  old.render(40);
  const current = h.create();
  expect(old.render(40)).toEqual(lines);
  expect(jest.getTimerCount()).toBe(0);
  expect(current.render(40)).toHaveLength(4);
  expect(jest.getTimerCount()).toBe(1);
  await h.pi.emit("session_shutdown", {}, h.ctx);
  expect(current.render(40)).toEqual(lines);
  expect(jest.getTimerCount()).toBe(0);
});

test("companion preserves status text occupying its docking columns", async () => {
  const lines = ["─".repeat(26) + "Working 42s" + "─".repeat(3), "prompt"];
  const h = lifecycleHarness(lines);
  await h.pi.emit("session_start", {}, h.ctx);
  const output = h.create().render(40);
  expect(output.slice(3)).toEqual(lines);
  expect(output.join("\n")).toContain("Working 42s");
  await h.pi.emit("session_shutdown", {}, h.ctx);
});

test("a later editor decorator does not cause duplicate companion installation", async () => {
  jest.useFakeTimers();
  const h = lifecycleHarness(["─".repeat(40), "prompt"]);
  await h.pi.emit("session_start", {}, h.ctx);
  const installed = h.factory();
  const outer = (...args: any[]) => installed(...args);
  h.ctx.ui.setEditorComponent(outer);
  await h.pi.emit("session_start", {}, h.ctx);
  expect(h.factory()).toBe(outer);
  expect(h.create().render(40)).toHaveLength(4);
  expect(jest.getTimerCount()).toBe(1);
  await h.pi.emit("session_shutdown", {}, h.ctx);
  expect(h.factory()).toBe(outer);
  expect(jest.getTimerCount()).toBe(0);
});
