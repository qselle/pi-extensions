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

test("uses Pi's public above-editor widget lifecycle and supports visibility controls", async () => {
  const pi = new MockPi();
  const widgets: Array<{ key: string; content: unknown; options?: unknown }> = [];
  const notices: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      setWidget: (key: string, content: unknown, options?: unknown) => {
        widgets.push({ key, content, options });
      },
      notify: (message: string) => notices.push(message),
    },
  };

  catBuddyExtension(pi as any);
  expect(pi.commands.has("cat")).toBe(true);
  expect(pi.shortcuts.has("ctrl+shift+c")).toBe(true);

  await pi.emit("session_start", {}, ctx);
  expect(widgets.at(-1)).toMatchObject({
    key: "cat-buddy",
    content: expect.any(Function),
    options: { placement: "aboveEditor" },
  });

  await pi.commands.get("cat").handler("hide", ctx);
  expect(widgets.at(-1)).toEqual({
    key: "cat-buddy",
    content: undefined,
    options: undefined,
  });
  expect(notices.at(-1)).toContain("hidden");

  await pi.commands.get("cat").handler("show", ctx);
  expect(widgets.at(-1)?.content).toBeInstanceOf(Function);

  await pi.emit("session_shutdown", {}, ctx);
  expect(widgets.at(-1)?.content).toBeUndefined();
});
