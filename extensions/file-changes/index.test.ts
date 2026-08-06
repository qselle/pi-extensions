import { expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

class MockCustomEditor {
  private text = "";
  borderColor = (value: string) => value;
  constructor(..._args: any[]) {}
  getText() { return this.text; }
  setText(text: string) { this.text = text; }
  handleInput(data: string) { if (data.length === 1 && data >= " ") this.text += data; }
  render() { return [this.text]; }
  invalidate() {}
}

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

mock.module("@earendil-works/pi-coding-agent", () => ({
  // Bun applies module mocks process-wide, so this shim must expose every symbol
  // any sibling suite imports from Pi — including the config helpers.
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => join(tmpdir(), "pi-agent-mock"),
  keyText: (id: string) => (id === "app.tools.expand" ? "ctrl+o" : ""),
  estimateTokens: (message: unknown) => Math.ceil(JSON.stringify(message ?? "").length / 4),
  DEFAULT_COMPACTION_SETTINGS: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
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
  sliceByColumn: (value: string, start: number, width: number) => value.slice(start, start + width),
  truncateToWidth: (value: string, width: number) => value.slice(0, width),
  visibleWidth: (value: string) => value.length,
  wrapTextWithAnsi: (value: string, width: number) => value.length <= width ? [value] : [value.slice(0, width), value.slice(width)],
}));

const { default: fileChangesExtension } = await import("./index.ts");
const { OverlayStackView } = await import("../overlay-stack/index.ts");
const { FILE_CHANGES_ENTRY_TYPE } = await import("./changes.ts");

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
  strikethrough: (value: string) => value,
} as any;

type Handler = (event: any, ctx: any) => any;

class MockPi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, any>();
  entries: any[] = [];

  on(name: string, handler: Handler) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  appendEntry(customType: string, data: unknown) {
    this.entries.push({ type: "custom", customType, data });
  }
  async emit(name: string, event: unknown, ctx: any) {
    for (const handler of this.handlers.get(name) ?? []) await handler(event, ctx);
  }
}

test("shows live edits, persists the last run, and restores branch-local state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-file-changes-index-"));
  const filePath = join(cwd, "app.ts");
  const pi = new MockPi();
  let branch: any[] = [];
  const notices: string[] = [];
  const ctx = {
    cwd,
    sessionManager: { getBranch: () => branch },
    ui: { notify: (message: string) => notices.push(message) },
  };
  const view = new OverlayStackView(theme);
  view.setViewport(120, 40);

  try {
    await writeFile(filePath, "export const value = 1;\n");
    fileChangesExtension(pi as any);
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.emit("before_agent_start", { prompt: "update app" }, ctx);
    await pi.emit("tool_call", {
      type: "tool_call",
      toolCallId: "edit-1",
      toolName: "edit",
      input: { path: "app.ts", edits: [] },
    }, ctx);
    await writeFile(filePath, "export const value = 2;\nexport const ready = true;\n");
    await pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "edit-1",
      toolName: "edit",
      input: { path: "app.ts", edits: [] },
      content: [],
      details: { diff: "", patch: "" },
      isError: false,
    }, ctx);

    const live = view.render(58).join("\n");
    expect(live).toContain("Changed files");
    expect(live).toContain("live");
    expect(live).toContain("app.ts");
    expect(live).toContain("+2");
    expect(live).toContain("-1");

    await pi.emit("agent_settled", {}, ctx);
    expect(pi.entries).toHaveLength(1);
    expect(pi.entries[0].customType).toBe(FILE_CHANGES_ENTRY_TYPE);
    expect(view.render(58).join("\n")).toContain("last run");

    const changedRunEntry = pi.entries[0];
    await pi.emit("before_agent_start", { prompt: "inspect only" }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    expect(pi.entries).toHaveLength(2);
    expect(view.render(58).join("\n")).not.toContain("Changed files");

    branch = [changedRunEntry];
    await pi.emit("session_tree", {}, ctx);
    expect(view.render(58).join("\n")).toContain("app.ts");

    pi.commands.get("file-changes").handler("hide", ctx);
    expect(view.render(58).join("\n")).not.toContain("Changed files");
    expect(notices.at(-1)).toContain("hidden");
    pi.commands.get("file-changes").handler("show", ctx);
    expect(view.render(58).join("\n")).toContain("Changed files");

    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    expect(view.render(58).join("\n")).not.toContain("Changed files");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tracks changes without invalidating the overlay while hidden", async () => {
  const pi = new MockPi();
  let invalidations = 0;
  let unregisters = 0;
  fileChangesExtension(pi as any, {
    registerCard: () => ({
      invalidate: () => { invalidations += 1; },
      unregister: () => { unregisters += 1; },
    }),
  });
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getBranch: () => [] },
    ui: { notify() {} },
  };

  await pi.emit("session_start", {}, ctx);
  expect(invalidations).toBe(1);
  await pi.commands.get("file-changes").handler("hide", ctx);
  expect(invalidations).toBe(2);

  await pi.emit("before_agent_start", {}, ctx);
  await pi.emit("agent_settled", {}, ctx);
  expect(invalidations).toBe(2);

  await pi.commands.get("file-changes").handler("show", ctx);
  expect(invalidations).toBe(3);
  await pi.emit("session_shutdown", {}, ctx);
  expect(unregisters).toBe(1);
});
