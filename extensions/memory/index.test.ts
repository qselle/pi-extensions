import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FILE,
  defaultMemoryConfig,
  loadMemoryConfig,
  type MemoryConfig,
} from "./config.ts";
import memoryExtension, { parseMemoryCommand } from "./index.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type Handler = (event: unknown, ctx: unknown) => unknown;

class MockPi {
  tool: any;
  commands = new Map<string, any>();
  handlers = new Map<string, Handler[]>();
  messages: unknown[] = [];

  registerTool(tool: any) { this.tool = tool; }
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  on(name: string, handler: Handler) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  }
  sendMessage(message: unknown) { this.messages.push(message); }
}

async function setup(overrides: Partial<MemoryConfig> = {}) {
  const base = await mkdtemp(join(tmpdir(), "pi-memory-index-"));
  temporaryDirectories.push(base);
  const agentDir = join(base, "agent");
  const cwd = join(base, "work", "project");
  await mkdir(join(cwd, ".git"), { recursive: true });
  const config = { ...defaultMemoryConfig(), enabled: true, ...overrides };
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, CONFIG_FILE), JSON.stringify(config));
  const pi = new MockPi();
  memoryExtension(pi as any, { agentDir });

  const notifications: Array<{ message: string; level: string }> = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  let confirmResult = true;
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "session-test" },
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      confirm: async (title: string, message: string) => {
        confirmations.push({ title, message });
        return confirmResult;
      },
    },
  } as any;
  return {
    base,
    agentDir,
    cwd,
    config,
    pi,
    ctx,
    notifications,
    confirmations,
    setConfirmResult(value: boolean) { confirmResult = value; },
  };
}

async function execute(pi: MockPi, ctx: any, input: Record<string, unknown>) {
  return pi.tool.execute("memory-call", input, undefined, undefined, ctx);
}

describe("registration and progressive disclosure", () => {
  test("registers one compact tool and one command without context injection hooks", async () => {
    const h = await setup();
    expect(h.pi.tool.name).toBe("memory");
    expect(h.pi.commands.has("memory")).toBe(true);
    expect(h.pi.tool.description).toContain("Contents are never preloaded");
    expect(h.pi.tool.promptGuidelines.join("\n")).toContain("never infer mutation consent");
    expect(h.pi.handlers.size).toBe(0);
    expect(h.pi.messages).toEqual([]);

    const serializedMetadata = JSON.stringify({
      description: h.pi.tool.description,
      promptSnippet: h.pi.tool.promptSnippet,
      promptGuidelines: h.pi.tool.promptGuidelines,
    });
    expect(serializedMetadata).not.toContain("private remembered value");
  });

  test("a disabled config removes the model tool while retaining status access", async () => {
    const h = await setup({ enabled: false });
    expect(h.pi.tool).toBeUndefined();
    await h.pi.commands.get("memory").handler("status", h.ctx);
    expect(h.notifications.at(-1)).toMatchObject({ level: "info" });
    expect(h.notifications.at(-1)?.message).toContain("memory: disabled");
    expect(h.notifications.at(-1)?.message).toContain("/memory enable");
  });

  test("explicit enable and disable persist the capability state without deleting records", async () => {
    const h = await setup({ enabled: false });
    await h.pi.commands.get("memory").handler("enable", h.ctx);
    expect(loadMemoryConfig(h.agentDir).enabled).toBe(true);
    expect(h.notifications.at(-1)?.message).toContain("Memory enabled persistently");
    expect(h.notifications.at(-1)?.message).toContain("/reload");
    expect(h.pi.tool).toBeUndefined();

    await h.pi.commands.get("memory").handler("remember keep this after disabling", h.ctx);
    const projectDirectory = join(h.agentDir, "memory", "projects");
    const [projectFile] = await readdir(projectDirectory);
    const path = join(projectDirectory, projectFile!);
    const storedBeforeDisable = await readFile(path, "utf8");
    expect(storedBeforeDisable).toContain("keep this after disabling");

    await h.pi.commands.get("memory").handler("disable", h.ctx);
    expect(loadMemoryConfig(h.agentDir).enabled).toBe(false);
    expect(await readFile(path, "utf8")).toBe(storedBeforeDisable);
    expect(h.notifications.at(-1)?.message).toContain("Stored memory records were not changed");
    expect(h.notifications.at(-1)?.message).toContain("blocked now");

    await h.pi.commands.get("memory").handler("search keep", h.ctx);
    expect(h.notifications.at(-1)).toMatchObject({ level: "error" });
    expect(h.notifications.at(-1)?.message).toContain("Memory is disabled");
  });
});

describe("explicit mutation consent", () => {
  test("tool remember shows the exact proposed text and persists only after confirmation", async () => {
    const h = await setup();
    h.setConfirmResult(false);
    const cancelled = await execute(h.pi, h.ctx, {
      action: "remember",
      text: "private remembered value",
      scope: "project",
    });
    expect(cancelled.details.cancelled).toBe(true);
    expect(cancelled.content[0].text).toContain("nothing was persisted");
    expect(h.confirmations[0]?.message).toContain("private remembered value");
    expect(existsSync(join(h.agentDir, "memory"))).toBe(false);

    h.setConfirmResult(true);
    const saved = await execute(h.pi, h.ctx, {
      action: "remember",
      text: "private remembered value",
      scope: "project",
      tags: ["preference"],
    });
    expect(saved.content[0].text).toContain("Remembered m_");
    expect(saved.content[0].text).toContain("path:");
    expect(existsSync(join(h.agentDir, "memory"))).toBe(true);
  });

  test("tool mutations fail closed without a UI unless confirmation was explicitly disabled", async () => {
    const h = await setup();
    const headless = { ...h.ctx, mode: "json", hasUI: false };
    await expect(execute(h.pi, headless, {
      action: "remember",
      text: "headless tool write",
      scope: "global",
    })).rejects.toThrow("require an interactive confirmation");

    const optedOut = await setup({ confirmToolMutations: false });
    const result = await execute(optedOut.pi, { ...optedOut.ctx, mode: "json", hasUI: false }, {
      action: "remember",
      text: "configured headless write",
      scope: "global",
    });
    expect(result.content[0].text).toContain("Remembered m_");
  });

  test("the explicit slash command can mutate headlessly without a second confirmation", async () => {
    const h = await setup();
    const headless = { ...h.ctx, mode: "json", hasUI: false };
    await h.pi.commands.get("memory").handler("remember --global concise answers", headless);
    expect(h.confirmations).toHaveLength(0);
    expect(h.notifications.at(-1)?.message).toContain("Remembered m_");

    const search = await execute(h.pi, h.ctx, { action: "search", query: "concise" });
    expect(search.content[0].text).toContain("concise answers");
  });

  test("tool forget previews the record and honors cancellation", async () => {
    const h = await setup();
    await h.pi.commands.get("memory").handler("remember keep this record", h.ctx);
    const match = await execute(h.pi, h.ctx, { action: "search", query: "keep record" });
    const id = match.details.result[0].id;

    h.setConfirmResult(false);
    const cancelled = await execute(h.pi, h.ctx, { action: "forget", id });
    expect(cancelled.details.cancelled).toBe(true);
    expect(h.confirmations.at(-1)?.message).toContain("keep this record");
    expect((await execute(h.pi, h.ctx, { action: "read", id })).content[0].text).toContain("keep this record");

    h.setConfirmResult(true);
    const forgotten = await execute(h.pi, h.ctx, { action: "forget", id });
    expect(forgotten.content[0].text).toContain(`Forgot ${id}`);
    expect((await execute(h.pi, h.ctx, { action: "read", id })).content[0].text).toContain("was not found");
  });
});

describe("command and tool behavior", () => {
  test("supports status, search, and read through bounded progressive disclosure", async () => {
    const h = await setup();
    await h.pi.commands.get("memory").handler("remember verify with bun test", h.ctx);
    const status = await execute(h.pi, h.ctx, { action: "status" });
    expect(status.content[0].text).toContain("1 active");
    expect(status.content[0].text).toContain("no session history is preloaded");

    const search = await execute(h.pi, h.ctx, { action: "search", query: "bun test" });
    expect(search.content[0].text).toContain("Use memory read with an ID");
    const id = search.details.result[0].id;
    const read = await execute(h.pi, h.ctx, { action: "read", id });
    expect(read.content[0].text).toContain("source: explicit request");
    expect(read.content[0].text).toContain("verify with bun test");
  });

  test("reports command validation failures without calling the model", async () => {
    const h = await setup();
    await h.pi.commands.get("memory").handler("search", h.ctx);
    expect(h.notifications.at(-1)).toEqual({ message: "Usage: /memory search <query>", level: "error" });
    await h.pi.commands.get("memory").handler("remember --global", h.ctx);
    expect(h.notifications.at(-1)?.level).toBe("error");
    await h.pi.commands.get("memory").handler("unknown", h.ctx);
    expect(h.notifications.at(-1)?.message).toContain("Usage: /memory");
  });

  test("offers action completions", async () => {
    const h = await setup();
    expect(h.pi.commands.get("memory").getArgumentCompletions("re").map((item: any) => item.value)).toEqual([
      "read",
      "remember",
    ]);
    expect(h.pi.commands.get("memory").getArgumentCompletions("dis").map((item: any) => item.value)).toEqual([
      "disable",
    ]);
    expect(h.pi.commands.get("memory").getArgumentCompletions("zzz")).toBeNull();
  });
});

describe("command parser", () => {
  test("uses the configured default scope and accepts explicit scope flags", () => {
    expect(parseMemoryCommand("remember a project fact", "project")).toEqual({
      action: "remember",
      scope: "project",
      text: "a project fact",
    });
    expect(parseMemoryCommand("remember --global a preference", "project")).toEqual({
      action: "remember",
      scope: "global",
      text: "a preference",
    });
    expect(parseMemoryCommand("", "project")).toEqual({ action: "status" });
    expect(parseMemoryCommand("enable", "project")).toEqual({ action: "enable" });
    expect(parseMemoryCommand("disable", "project")).toEqual({ action: "disable" });
    expect(() => parseMemoryCommand("disable now", "project")).toThrow("Usage: /memory");
  });
});
