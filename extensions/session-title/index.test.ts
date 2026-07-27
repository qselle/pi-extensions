import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sessionTitleExtension, { loadConfig, statusText, type SessionTitleConfig } from "./index.ts";
import type { TitleResult } from "./request.ts";

function config(overrides: Partial<SessionTitleConfig> = {}): SessionTitleConfig {
  return { enabled: true, refreshEvery: 5, ...overrides };
}

class MockPi {
  handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  commands = new Map<string, any>();
  name: string | undefined;
  names: string[] = [];

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

function setup(options: { config?: SessionTitleConfig; results?: TitleResult[]; name?: string } = {}) {
  const pi = new MockPi();
  if (options.name) pi.name = options.name;
  const calls: any[] = [];
  const results = options.results ?? [{ title: "Generated Title", model: "m", usage: { input: 1, output: 1, cost: 0.0002 } }];
  let index = 0;
  sessionTitleExtension(pi as any, {
    config: options.config ?? config(),
    request: (async (args: any) => { calls.push(args); return results[Math.min(index++, results.length - 1)]!; }) as any,
  });
  const notifications: { message: string; level?: string }[] = [];
  const ctx: any = { signal: undefined, ui: { notify: (m: string, l?: string) => notifications.push({ message: m, level: l }) } };
  return { pi, calls, notifications, ctx };
}

async function firstTurn(h: ReturnType<typeof setup>, prompt = "please fix the retry loop in fetch") {
  await h.pi.emit("session_start", {}, h.ctx);
  await h.pi.emit("before_agent_start", { prompt }, h.ctx);
}

describe("loadConfig", () => {
  test("defaults to enabled with the standard refresh interval", () => {
    expect(loadConfig(join(tmpdir(), "no-such-dir-title"))).toEqual({ enabled: true, model: undefined, refreshEvery: 5 });
  });

  test("reads model, refreshEvery, and enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "title-cfg-"));
    writeFileSync(join(dir, "session-title.json"), JSON.stringify({ enabled: false, model: "openai/gpt-4.1-mini", refreshEvery: 3 }));
    expect(loadConfig(dir)).toEqual({ enabled: false, model: "openai/gpt-4.1-mini", refreshEvery: 3 });
  });

  test("ignores junk values and malformed files", () => {
    const dir = mkdtempSync(join(tmpdir(), "title-cfg-"));
    writeFileSync(join(dir, "session-title.json"), JSON.stringify({ model: "nope", refreshEvery: -2 }));
    expect(loadConfig(dir)).toEqual({ enabled: true, model: undefined, refreshEvery: 5 });
    writeFileSync(join(dir, "session-title.json"), "{oops");
    expect(loadConfig(dir).enabled).toBe(true);
  });
});

describe("provisional title", () => {
  test("names the session immediately from the first prompt, with no model call", async () => {
    const h = setup();
    await firstTurn(h);
    expect(h.pi.name).toBe("fix retry loop fetch");
    expect(h.calls).toHaveLength(0);
  });

  test("does not overwrite an existing name", async () => {
    const h = setup({ name: "Existing name" });
    await firstTurn(h);
    expect(h.pi.name).toBe("Existing name");
  });

  test("ignores empty prompts", async () => {
    const h = setup();
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.emit("before_agent_start", { prompt: "   " }, h.ctx);
    await h.pi.emit("agent_settled", {}, h.ctx);
    expect(h.pi.name).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });
});

describe("generated title", () => {
  test("replaces the provisional title after the turn settles", async () => {
    const h = setup();
    await firstTurn(h);
    await h.pi.emit("agent_settled", {}, h.ctx);
    expect(h.calls).toHaveLength(1);
    expect(h.pi.name).toBe("Generated Title");
    expect(h.pi.names).toEqual(["fix retry loop fetch", "Generated Title"]);
  });

  test("sends only user text, the anchor, and the current title", async () => {
    const h = setup();
    await firstTurn(h, "add hyperlinks to tool blocks");
    await h.pi.emit("before_agent_start", { prompt: "now add stats" }, h.ctx);
    await h.pi.emit("agent_settled", {}, h.ctx);
    const prompt = h.calls[0].prompt as string;
    expect(prompt).toContain("first_request: add hyperlinks to tool blocks");
    expect(prompt).toContain("- now add stats");
    expect(prompt).toContain("current_title:");
  });

  test("passes the configured model override", async () => {
    const h = setup({ config: config({ model: "openai/gpt-4.1-mini" }) });
    await firstTurn(h);
    await h.pi.emit("agent_settled", {}, h.ctx);
    expect(h.calls[0].override).toBe("openai/gpt-4.1-mini");
  });

  test("does not retitle before the refresh interval", async () => {
    const h = setup();
    await firstTurn(h);
    await h.pi.emit("agent_settled", {}, h.ctx);
    for (let turn = 0; turn < 3; turn += 1) {
      await h.pi.emit("before_agent_start", { prompt: `turn ${turn}` }, h.ctx);
      await h.pi.emit("agent_settled", {}, h.ctx);
    }
    expect(h.calls).toHaveLength(1);
  });

  test("retitles once the interval passes", async () => {
    const h = setup({ config: config({ refreshEvery: 2 }) });
    await firstTurn(h);
    await h.pi.emit("agent_settled", {}, h.ctx);
    await h.pi.emit("before_agent_start", { prompt: "second" }, h.ctx);
    await h.pi.emit("before_agent_start", { prompt: "third" }, h.ctx);
    await h.pi.emit("agent_settled", {}, h.ctx);
    expect(h.calls).toHaveLength(2);
  });

  test("keeps the old name when titling fails", async () => {
    const h = setup({ results: [{ error: "rate limited" }] });
    await firstTurn(h);
    await h.pi.emit("agent_settled", {}, h.ctx);
    expect(h.pi.name).toBe("fix retry loop fetch");
  });

  test("does nothing when disabled", async () => {
    const h = setup({ config: config({ enabled: false }) });
    await firstTurn(h);
    await h.pi.emit("agent_settled", {}, h.ctx);
    expect(h.calls).toHaveLength(0);
    expect(h.pi.name).toBeUndefined();
  });
});

describe("manual rename", () => {
  test("stops automatic titling once the user renames", async () => {
    const h = setup();
    await firstTurn(h);
    await h.pi.emit("session_info_changed", { name: "My own name" }, h.ctx);
    await h.pi.emit("before_agent_start", { prompt: "more work" }, h.ctx);
    await h.pi.emit("agent_settled", {}, h.ctx);
    expect(h.calls).toHaveLength(0);
    expect(h.pi.name).toBe("fix retry loop fetch");
  });

  test("does not treat its own title as a manual rename", async () => {
    const h = setup();
    await firstTurn(h);
    await h.pi.emit("session_info_changed", { name: "fix retry loop fetch" }, h.ctx);
    await h.pi.emit("agent_settled", {}, h.ctx);
    expect(h.calls).toHaveLength(1);
  });
});

describe("/title", () => {
  test("status reports title, model, and turn accounting", async () => {
    const h = setup();
    await firstTurn(h);
    await h.pi.emit("agent_settled", {}, h.ctx);
    await h.pi.commands.get("title").handler("status", h.ctx);
    const message = h.notifications.at(-1)!.message;
    expect(message).toContain("title: Generated Title");
    expect(message).toContain("automatic: on");
    expect(message).toContain("user turns: 1");
  });

  test("set applies a title and disables automatic titling", async () => {
    const h = setup();
    await firstTurn(h);
    await h.pi.commands.get("title").handler("set  My  Chosen Title ", h.ctx);
    expect(h.pi.name).toBe("My Chosen Title");
    await h.pi.emit("agent_settled", {}, h.ctx);
    expect(h.calls).toHaveLength(0);
  });

  test("auto re-enables titling after a manual set", async () => {
    const h = setup();
    await firstTurn(h);
    await h.pi.commands.get("title").handler("set Mine", h.ctx);
    await h.pi.commands.get("title").handler("auto", h.ctx);
    await h.pi.emit("agent_settled", {}, h.ctx);
    expect(h.calls).toHaveLength(1);
  });

  test("now regenerates immediately and reports cost", async () => {
    const h = setup();
    await firstTurn(h);
    await h.pi.commands.get("title").handler("now", h.ctx);
    expect(h.calls).toHaveLength(1);
    expect(h.notifications.at(-1)?.message).toContain("Generated Title");
    expect(h.notifications.at(-1)?.message).toContain("$0.0002");
  });

  test("now reports a failure as an error", async () => {
    const h = setup({ results: [{ error: "boom" }] });
    await firstTurn(h);
    await h.pi.commands.get("title").handler("now", h.ctx);
    expect(h.notifications.at(-1)?.level).toBe("error");
  });

  test("now needs at least one turn", async () => {
    const h = setup();
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.commands.get("title").handler("now", h.ctx);
    expect(h.calls).toHaveLength(0);
    expect(h.notifications.at(-1)?.message).toContain("Nothing to title yet");
  });

  test("rejects unknown subcommands and bad set input", async () => {
    const h = setup();
    await h.pi.commands.get("title").handler("bogus", h.ctx);
    expect(h.notifications.at(-1)?.level).toBe("error");
    await h.pi.commands.get("title").handler("set   ", h.ctx);
    expect(h.notifications.at(-1)?.message).toContain("Usage: /title set");
  });

  test("completes subcommands", async () => {
    const h = setup();
    expect(h.pi.commands.get("title").getArgumentCompletions("s").map((i: any) => i.value)).toEqual(["status", "set"]);
    expect(h.pi.commands.get("title").getArgumentCompletions("zz")).toBeNull();
  });
});

describe("statusText", () => {
  test("marks a manual rename and surfaces the last error", () => {
    const text = statusText(config(), { userTurns: 3, titledAtTurn: 1, manual: true }, "Mine", { error: "no credentials" });
    expect(text).toContain("automatic: off (renamed manually)");
    expect(text).toContain("last error: no credentials");
  });
});
