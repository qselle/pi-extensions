import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sessionTitleExtension, { agentDirectory, loadConfig, statusText, type SessionTitleConfig } from "./index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TitleResult } from "./request.ts";

const config = (overrides: Partial<SessionTitleConfig> = {}): SessionTitleConfig => ({ enabled: true, ...overrides });

class MockPi {
  handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  commands = new Map<string, any>();
  name: string | undefined;
  names: string[] = [];
  emitted: Array<{ name: string; value: unknown }> = [];
  events = { emit: (name: string, value: unknown) => { this.emitted.push({ name, value }); } };

  on(event: string, handler: (event: any, ctx: any) => any) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  setSessionName(name: string) { this.name = name; this.names.push(name); }
  getSessionName() { return this.name; }
  async emit(event: string, payload: any = {}, ctx: any = {}) {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
  }
}

function setup(options: {
  config?: SessionTitleConfig;
  results?: TitleResult[];
  name?: string;
  request?: (args: any) => Promise<TitleResult>;
} = {}) {
  const pi = new MockPi();
  if (options.name) pi.name = options.name;
  const calls: any[] = [];
  const results = options.results ?? [{ title: "Generated Title", model: "haiku", usage: { input: 174, output: 4, cost: 0.0002 } }];
  let index = 0;
  sessionTitleExtension(pi as any, {
    config: options.config ?? config(),
    request: (async (args: any) => {
      calls.push(args);
      if (options.request) return options.request(args);
      return results[Math.min(index++, results.length - 1)]!;
    }) as any,
  });
  const notifications: { message: string; level?: string }[] = [];
  const branch: any[] = [];
  const ctx: any = {
    signal: undefined,
    sessionManager: { getBranch: () => branch },
    ui: { notify: (m: string, l?: string) => notifications.push({ message: m, level: l }) },
  };
  return { pi, calls, notifications, ctx, branch };
}

const userEntry = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });

async function flushDetachedRequest(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function firstTurn(h: ReturnType<typeof setup>, prompt = "please fix the retry loop in fetch") {
  await h.pi.emit("session_start", {}, h.ctx);
  await h.pi.emit("before_agent_start", { prompt }, h.ctx);
  await flushDetachedRequest();
}

describe("loadConfig", () => {
  test("defaults to enabled", () => {
    expect(loadConfig(join(tmpdir(), "missing-title-dir"))).toEqual({ enabled: true });
  });
  test("reads enabled and model, ignoring junk", () => {
    const dir = mkdtempSync(join(tmpdir(), "title-cfg-"));
    writeFileSync(join(dir, "session-title.json"), JSON.stringify({ enabled: false, model: "openai/gpt-4.1-mini" }));
    expect(loadConfig(dir)).toEqual({ enabled: false, model: "openai/gpt-4.1-mini" });
    writeFileSync(join(dir, "session-title.json"), JSON.stringify({ model: "nope" }));
    expect(loadConfig(dir)).toEqual({ enabled: true, model: undefined });
    writeFileSync(join(dir, "session-title.json"), "{oops");
    expect(loadConfig(dir)).toEqual({ enabled: true });
  });
});

describe("titling once", () => {
  test("starts one model title from the first meaningful request", async () => {
    const h = setup();
    await firstTurn(h);
    expect(h.calls).toHaveLength(1);
    expect(h.pi.names).toEqual(["Generated Title"]);
    expect(h.calls[0].prompt).toContain("first_request: please fix the retry loop in fetch");
  });

  test("does not block the main request while the title is generated", async () => {
    let finish!: (result: TitleResult) => void;
    const pending = new Promise<TitleResult>((resolve) => { finish = resolve; });
    const h = setup({ request: async () => pending });
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.emit("before_agent_start", { prompt: "redesign the footer" }, h.ctx);
    expect(h.calls).toHaveLength(1);
    expect(h.pi.name).toBeUndefined();
    expect(h.pi.emitted.at(-1)).toEqual({
      name: "footer:badge",
      value: { id: "session-title", text: "naming…", order: -100 },
    });

    finish({ title: "Pi Footer Redesign" });
    await flushDetachedRequest();
    expect(h.pi.name).toBe("Pi Footer Redesign");
    expect(h.pi.emitted.at(-1)).toEqual({
      name: "footer:badge",
      value: { id: "session-title" },
    });
  });

  test("never titles again after the first automatic attempt", async () => {
    const h = setup();
    await firstTurn(h);
    for (let turn = 0; turn < 10; turn += 1) {
      await h.pi.emit("before_agent_start", { prompt: `turn ${turn}` }, h.ctx);
      await h.pi.emit("agent_settled", {}, h.ctx);
    }
    expect(h.calls).toHaveLength(1);
  });

  test("leaves an already-named session alone, so /name is safe", async () => {
    const h = setup({ name: "Important Thing" });
    await firstTurn(h);
    expect(h.calls).toHaveLength(0);
    expect(h.pi.name).toBe("Important Thing");
  });

  test("uses only the triggering user request", async () => {
    const h = setup();
    await firstTurn(h, "add hyperlinks to tool blocks");
    await h.pi.emit("before_agent_start", { prompt: "now add stats" }, h.ctx);
    const prompt = h.calls[0].prompt as string;
    expect(prompt).toContain("first_request: add hyperlinks to tool blocks");
    expect(prompt).not.toContain("now add stats");
  });

  test("passes the configured model override", async () => {
    const h = setup({ config: config({ model: "openai/gpt-4.1-mini" }) });
    await firstTurn(h);
    expect(h.calls[0].override).toBe("openai/gpt-4.1-mini");
  });

  test("leaves the session unnamed and does not retry when titling fails", async () => {
    const h = setup({ results: [{ error: "rate limited" }, { title: "Second Try" }] });
    await firstTurn(h);
    expect(h.pi.name).toBeUndefined();
    await h.pi.emit("before_agent_start", { prompt: "another request" }, h.ctx);
    await h.pi.emit("agent_settled", {}, h.ctx);
    expect(h.calls).toHaveLength(1);
    expect(h.pi.name).toBeUndefined();
  });

  test("does not overwrite a manual name assigned while generation is running", async () => {
    let finish!: (result: TitleResult) => void;
    const pending = new Promise<TitleResult>((resolve) => { finish = resolve; });
    const h = setup({ request: async () => pending });
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.emit("before_agent_start", { prompt: "redesign the footer" }, h.ctx);
    h.pi.setSessionName("My Name");
    finish({ title: "Generated Title" });
    await flushDetachedRequest();
    expect(h.pi.name).toBe("My Name");
  });

  test("aborts and ignores title generation after session shutdown", async () => {
    let finish!: (result: TitleResult) => void;
    const pending = new Promise<TitleResult>((resolve) => { finish = resolve; });
    const h = setup({ request: async () => pending });
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.emit("before_agent_start", { prompt: "redesign the footer" }, h.ctx);
    await h.pi.emit("session_shutdown", {}, h.ctx);
    expect(h.calls[0].signal.aborted).toBe(true);
    finish({ title: "Stale Title" });
    await flushDetachedRequest();
    expect(h.pi.name).toBeUndefined();
  });

  test("waits through greetings for the first meaningful request", async () => {
    const h = setup();
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.emit("before_agent_start", { prompt: "hello" }, h.ctx);
    expect(h.calls).toHaveLength(0);
    await h.pi.emit("before_agent_start", { prompt: "redesign the Pi footer" }, h.ctx);
    await flushDetachedRequest();
    expect(h.calls).toHaveLength(1);
    expect(h.pi.name).toBe("Generated Title");
  });

  test("does nothing when disabled", async () => {
    const h = setup({ config: config({ enabled: false }) });
    await firstTurn(h);
    expect(h.calls).toHaveLength(0);
    expect(h.pi.name).toBeUndefined();
  });

  test("ignores empty prompts", async () => {
    const h = setup();
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.emit("before_agent_start", { prompt: "   " }, h.ctx);
    expect(h.pi.name).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });
});

describe("loading into an existing session", () => {
  test("recovers prompts so /title now works immediately", async () => {
    const h = setup();
    h.branch.push(userEntry("hello"), userEntry("add hyperlinks"), userEntry("now add stats"));
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.commands.get("title").handler("now", h.ctx);
    expect(h.calls[0].prompt).toContain("first_request: add hyperlinks");
    expect(h.pi.name).toBe("Generated Title");
  });

  test("does not retroactively title an unnamed resumed session", async () => {
    const h = setup();
    h.branch.push(userEntry("prior substantive work"));
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.emit("before_agent_start", { prompt: "new work" }, h.ctx);
    await h.pi.emit("agent_settled", {}, h.ctx);
    expect(h.calls).toHaveLength(0);
    expect(h.pi.name).toBeUndefined();
  });

  test("can title after a resumed branch that only contained greetings", async () => {
    const h = setup();
    h.branch.push(userEntry("hello"));
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.emit("before_agent_start", { prompt: "redesign the footer" }, h.ctx);
    await flushDetachedRequest();
    expect(h.calls).toHaveLength(1);
    expect(h.pi.name).toBe("Generated Title");
  });

  test("does not touch a named resumed session", async () => {
    const h = setup({ name: "Existing name" });
    h.branch.push(userEntry("a"));
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.emit("agent_settled", {}, h.ctx);
    expect(h.calls).toHaveLength(0);
  });

  test("ignores assistant, custom, and image-only entries", async () => {
    const h = setup();
    h.branch.push(
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
      { type: "custom", customType: "x", data: {} },
      { type: "message", message: { role: "user", content: [{ type: "image", data: "..." }] } },
      userEntry("real prompt"),
    );
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.commands.get("title").handler("now", h.ctx);
    expect(h.calls[0].prompt).toContain("first_request: real prompt");
    expect(h.calls[0].prompt).not.toContain("reply");
  });
});

describe("/title", () => {
  test("status reports title, model, and tracked prompts", async () => {
    const h = setup();
    await firstTurn(h);
    await h.pi.commands.get("title").handler("status", h.ctx);
    const message = h.notifications.at(-1)!.message;
    expect(message).toContain("title: Generated Title");
    expect(message).toContain("prompts tracked: 1");
    expect(message).toContain("$0.0002");
  });

  test("set applies a title and stops titling", async () => {
    const h = setup();
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.commands.get("title").handler("set  My  Chosen Title ", h.ctx);
    expect(h.pi.name).toBe("My Chosen Title");
    await h.pi.emit("before_agent_start", { prompt: "redesign the footer" }, h.ctx);
    expect(h.calls).toHaveLength(0);
  });

  test("now shows renaming, regenerates a named session, and reports cost", async () => {
    const h = setup({ name: "Old" });
    h.branch.push(userEntry("some work"));
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.commands.get("title").handler("now", h.ctx);
    expect(h.calls).toHaveLength(1);
    expect(h.pi.emitted).toContainEqual({
      name: "footer:badge",
      value: { id: "session-title", text: "renaming…", order: -100 },
    });
    expect(h.pi.emitted.at(-1)).toEqual({
      name: "footer:badge",
      value: { id: "session-title" },
    });
    expect(h.notifications.at(-1)?.message).toContain("Generated Title");
  });

  test("now reports failures and needs at least one prompt", async () => {
    const h = setup({ results: [{ error: "boom" }] });
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.commands.get("title").handler("now", h.ctx);
    expect(h.notifications.at(-1)?.message).toContain("Nothing to title yet");
    await firstTurn(h);
    await h.pi.commands.get("title").handler("now", h.ctx);
    expect(h.notifications.at(-1)?.level).toBe("error");
  });

  test("rejects bad input and completes subcommands", async () => {
    const h = setup();
    await h.pi.commands.get("title").handler("bogus", h.ctx);
    expect(h.notifications.at(-1)?.level).toBe("error");
    await h.pi.commands.get("title").handler("set  ", h.ctx);
    expect(h.notifications.at(-1)?.message).toContain("Usage: /title set");
    expect(h.pi.commands.get("title").getArgumentCompletions("s").map((i: any) => i.value)).toEqual(["status", "set"]);
    expect(h.pi.commands.get("title").getArgumentCompletions("zz")).toBeNull();
  });
});

describe("statusText", () => {
  test("reports pending, done, and off states", () => {
    expect(statusText(config(), undefined, 0, undefined)).toContain("automatic: pending");
    expect(statusText(config(), "Some Title", 2, undefined)).toContain("automatic: done (named)");
    expect(statusText(config({ enabled: false }), undefined, 0, undefined)).toContain("automatic: off");
  });
  test("surfaces the last error", () => {
    expect(statusText(config(), undefined, 1, { error: "no credentials" })).toContain("last error: no credentials");
  });
});

test("resolves the agent directory through Pi rather than hardcoding .pi", () => {
  expect(agentDirectory()).toBe(getAgentDir());
});
