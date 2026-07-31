import { expect, test } from "bun:test";
import catBuddyExtension from "./index.ts";

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
  expect(colorCalls).toBeGreaterThan(0);
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
