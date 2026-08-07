import { expect, test } from "bun:test";
import contextExtension, { collectReport, CONTEXT_REPORT_ENTRY, type ContextCommandContext } from "./index.ts";
import type { Estimators } from "./analysis.ts";

/** Deterministic stand-ins so token figures in assertions are exact. */
const estimators: Estimators = {
  text: (value: string) => Math.ceil(value.length / 4),
  entry: (entry: unknown) => (entry as { tokens?: number })?.tokens ?? 0,
};

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

class MockPi {
  commands = new Map<string, any>();
  renderers = new Map<string, any>();
  entries: Array<{ type: string; data: any }> = [];
  activeTools: string[] = [];
  allTools: any[] = [];

  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  registerEntryRenderer(type: string, renderer: any) { this.renderers.set(type, renderer); }
  appendEntry(type: string, data: any) { this.entries.push({ type, data }); }
  getAllTools() { return this.allTools; }
  getActiveTools() { return this.activeTools; }
}

function commandContext(overrides: Partial<ContextCommandContext> = {}): any {
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx: any = {
    mode: "tui",
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    model: { contextWindow: 200_000 },
    getContextUsage: () => ({ tokens: 27_900, contextWindow: 258_000 }),
    getSystemPrompt: () => "s".repeat(400),
    getSystemPromptOptions: () => ({
      promptGuidelines: ["g".repeat(40)],
      toolSnippets: { subagents: "snippet" },
      contextFiles: [{ path: "AGENTS.md", content: "a".repeat(80) }],
      skills: [],
    }),
    sessionManager: {
      buildContextEntries: () => [
        { type: "message", tokens: 500, message: { role: "user" } },
        { type: "message", tokens: 900, message: { role: "toolResult", toolName: "bash" } },
        { type: "message", tokens: 120, message: { role: "custom", customType: "goal-context" } },
      ],
    },
    ...overrides,
  };
  ctx.notifications = notifications;
  return ctx;
}

test("registers the command and a TUI-only entry renderer", () => {
  const pi = new MockPi();
  contextExtension(pi as any, { estimators });

  expect([...pi.commands.keys()]).toEqual(["context"]);
  expect(pi.renderers.has(CONTEXT_REPORT_ENTRY)).toBe(true);
});

test("measures only the tools whose schemas are actually sent", () => {
  const pi = new MockPi();
  pi.allTools = [
    { name: "bash", description: "d".repeat(40), parameters: { type: "object" } },
    { name: "dormant", description: "x".repeat(400), parameters: { type: "object" } },
  ];
  pi.activeTools = ["bash"];

  const report = collectReport(pi as any, commandContext(), estimators);

  expect(report.tools.buckets.map((bucket) => bucket.label)).toEqual(["bash"]);
  expect(report.tools.buckets[0]!.tokens).toBeLessThan(40);
});

test("reads the window, provider count, and compaction reserve from pi", () => {
  const pi = new MockPi();
  const report = collectReport(pi as any, commandContext(), estimators);

  expect(report.window).toBe(258_000);
  expect(report.reported).toBe(27_900);
  // Derived from pi's own DEFAULT_COMPACTION_SETTINGS.reserveTokens.
  expect(report.compactAt).toBeGreaterThan(0);
  expect(report.compactAt).toBeLessThan(258_000);
  expect(report.system.total).toBe(100);
  expect(report.conversation.total).toBe(1_520);
  expect(report.estimated).toBe(report.system.total + report.tools.total + report.conversation.total);
});

test("itemizes each extension's own injection by customType", () => {
  const pi = new MockPi();
  const report = collectReport(pi as any, commandContext(), estimators);

  expect(report.conversation.buckets.map((bucket) => bucket.id)).toContain("custom:goal-context");
  expect(report.conversation.buckets.find((bucket) => bucket.id === "custom:goal-context")?.tokens).toBe(120);
});

test("appends a report entry in TUI mode and renders it at the given width", () => {
  const pi = new MockPi();
  contextExtension(pi as any, { estimators });
  const ctx = commandContext();

  pi.commands.get("context").handler("", ctx);

  expect(pi.entries).toHaveLength(1);
  expect(pi.entries[0]!.type).toBe(CONTEXT_REPORT_ENTRY);
  expect(ctx.notifications).toHaveLength(0);

  const card = pi.renderers.get(CONTEXT_REPORT_ENTRY)(pi.entries[0], { expanded: false }, theme);
  const lines = card.render(80);
  expect(lines[0]).toContain("Context");
  expect(lines.join("\n")).toContain("context: goal-context");
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
});

test("notifies instead of appending when there is no TUI", async () => {
  const pi = new MockPi();
  contextExtension(pi as any, { estimators });
  const ctx = commandContext({ mode: "json" });

  await pi.commands.get("context").handler("", ctx);

  expect(pi.entries).toHaveLength(0);
  expect(ctx.notifications).toHaveLength(1);
  expect(ctx.notifications[0].message).toContain("Context");
  expect(ctx.notifications[0].level).toBe("info");
});

test("survives a host that omits or throws from the accessors it reads", () => {
  const pi = new MockPi();
  const hostile: any = {
    mode: "tui",
    ui: { notify: () => undefined },
    getSystemPrompt: () => { throw new Error("nope"); },
    getSystemPromptOptions: () => { throw new Error("nope"); },
    getContextUsage: () => { throw new Error("nope"); },
    sessionManager: { buildContextEntries: () => { throw new Error("nope"); } },
  };

  const report = collectReport(pi as any, hostile, estimators);

  expect(report.estimated).toBe(0);
  expect(report.window).toBe(0);
  expect(report.compactAt).toBeUndefined();
});

test("falls back to the branch when buildContextEntries is unavailable", () => {
  const pi = new MockPi();
  const ctx = commandContext({
    sessionManager: { getBranch: () => [{ type: "message", tokens: 42, message: { role: "user" } }] } as any,
  });

  const report = collectReport(pi as any, ctx, estimators);

  expect(report.conversation.total).toBe(42);
});

test("shortens absolute context-file paths to session-relative labels", () => {
  const pi = new MockPi();
  const ctx = commandContext({
    cwd: "/work/project",
    getSystemPromptOptions: () => ({
      contextFiles: [
        { path: "/work/project/AGENTS.md", content: "a".repeat(80) },
        { path: "/work/project/docs/guide.md", content: "b".repeat(40) },
      ],
    }),
  } as any);

  const report = collectReport(pi as any, ctx, estimators);
  const labels = report.system.buckets.map((bucket) => bucket.label);

  expect(labels).toContain("AGENTS.md");
  expect(labels).toContain("docs/guide.md");
  expect(labels.some((label) => label.startsWith("/work"))).toBe(false);
});

test("renders an empty report rather than throwing on a malformed entry", () => {
  const pi = new MockPi();
  contextExtension(pi as any, { estimators });

  const card = pi.renderers.get(CONTEXT_REPORT_ENTRY)({ data: undefined }, { expanded: false }, theme);

  expect(card.render(60)[0]).toContain("Context");
});
