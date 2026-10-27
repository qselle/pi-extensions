import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sessionTitleExtension, { agentDirectory, loadConfig, statusText, watchConfig, type SessionTitleConfig } from "./index.ts";
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
  constructor(readonly entries: any[]) {}

  on(event: string, handler: (event: any, ctx: any) => any) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  flags = new Map<string, unknown>();
  registerFlag(name: string, options: { default?: unknown }) { this.flags.set(name, options.default); }
  getFlag(name: string) { return this.flags.get(name); }
  appendEntry(customType: string, data: unknown) {
    this.entries.push({ type: "custom", id: `e${this.entries.length}`, customType, data: structuredClone(data) });
  }
  /** Like Pi, a name change is announced to extensions asynchronously. */
  setSessionName(name: string) {
    this.name = name;
    this.names.push(name);
    queueMicrotask(() => void this.emit("session_info_changed", { name }, {}));
  }
  getSessionName() { return this.name; }
  async emit(event: string, payload: any = {}, ctx: any = {}) {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
  }
}

function setup(options: {
  config?: SessionTitleConfig;
  results?: TitleResult[];
  name?: string;
  env?: NodeJS.ProcessEnv;
  request?: (args: any) => Promise<TitleResult>;
} = {}) {
  const branch: any[] = [];
  const pi = new MockPi(branch);
  if (options.name) pi.name = options.name;
  const calls: any[] = [];
  const results = options.results ?? [{ title: "Generated Title", model: "haiku", usage: { input: 174, output: 4, cost: 0.0002 } }];
  let index = 0;
  sessionTitleExtension(pi as any, {
    config: options.config ?? config(),
    env: options.env ?? {},
    request: (async (args: any) => {
      calls.push(args);
      if (options.request) return options.request(args);
      return results[Math.min(index++, results.length - 1)]!;
    }) as any,
  });
  const notifications: { message: string; level?: string }[] = [];
  const ctx: any = {
    signal: undefined,
    sessionManager: { getBranch: () => branch, getEntries: () => branch },
    ui: { notify: (m: string, l?: string) => notifications.push({ message: m, level: l }) },
  };
  return { pi, calls, notifications, ctx, branch };
}

let nextId = 0;
const userEntry = (text: string) => ({ type: "message", id: `m${nextId++}`, message: { role: "user", content: [{ type: "text", text }] } });
const assistantEntry = (text: string) => ({ type: "message", id: `m${nextId++}`, message: { role: "assistant", content: [{ type: "text", text }] } });
const states = (h: ReturnType<typeof setup>) => h.branch.filter((entry) => entry.customType === "session-title:state").map((entry) => entry.data);
const focusPrompt = (call: any) => JSON.parse(call.prompt);

async function flushDetachedRequest(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Start a turn the way Pi does: before_agent_start, then the request joins the branch. */
async function prompt(h: ReturnType<typeof setup>, text: string) {
  await h.pi.emit("before_agent_start", { prompt: text }, h.ctx);
  h.branch.push(userEntry(text));
  await flushDetachedRequest();
}

async function settle(h: ReturnType<typeof setup>, reply: string) {
  h.branch.push(assistantEntry(reply));
  await h.pi.emit("agent_settled", {}, h.ctx);
  await flushDetachedRequest();
}

async function firstTurn(h: ReturnType<typeof setup>, text = "please fix the retry loop in fetch") {
  await h.pi.emit("session_start", {}, h.ctx);
  await prompt(h, text);
}

test("rename preserves manual wording and defeats a late generated title", async () => {
  let finish!: (result: TitleResult) => void;
  const h = setup({ request: async () => new Promise((resolve) => { finish = resolve; }) });
  await h.pi.emit("session_start", {}, h.ctx);
  await h.pi.emit("before_agent_start", { prompt: "investigate long running network requests" }, h.ctx);
  await h.pi.commands.get("rename").handler("My exact title: with more than four words!", h.ctx);
  finish({ title: "Late Generated Title" });
  await flushDetachedRequest();
  expect(h.pi.name).toBe("My exact title: with more than four words!");
});

test("rename prompt cancellation and session replacement leave the name unchanged", async () => {
  const h = setup({ name: "Existing" });
  h.ctx.mode = "tui";
  h.ctx.ui.input = async () => undefined;
  await h.pi.commands.get("rename").handler("", h.ctx);
  expect(h.pi.name).toBe("Existing");
  h.ctx.ui.input = async () => {
    await h.pi.emit("session_shutdown", {}, h.ctx);
    return "stale title";
  };
  await h.pi.commands.get("rename").handler("", h.ctx);
  expect(h.pi.name).toBe("Existing");
});

test("an explicit title request cannot notify a replaced session", async () => {
  let finish!: (result: TitleResult) => void;
  const h = setup({ name: "Existing", request: async () => new Promise((resolve) => { finish = resolve; }) });
  h.branch.push(userEntry("existing work"));
  await h.pi.emit("session_start", {}, h.ctx);
  const command = h.pi.commands.get("title").handler("now", h.ctx);
  await h.pi.emit("session_shutdown", {}, h.ctx);
  h.ctx.ui.notify = () => { throw new Error("stale UI"); };
  finish({ title: "Late title" });
  await command;
  expect(h.pi.name).toBe("Existing");
});

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

  test("reads an ordered models list that takes precedence over model", () => {
    const dir = mkdtempSync(join(tmpdir(), "title-models-"));
    writeFileSync(join(dir, "session-title.json"), JSON.stringify({
      model: "openai/gpt-4.1-mini",
      models: ["mistral/mistral-medium-3.5", "junk", 3, "openai/gpt-4.1-mini", "mistral/mistral-medium-3.5"],
    }));
    expect(loadConfig(dir)).toEqual({
      enabled: true,
      model: "mistral/mistral-medium-3.5",
      models: ["mistral/mistral-medium-3.5", "openai/gpt-4.1-mini"],
    });
    writeFileSync(join(dir, "session-title.json"), JSON.stringify({ model: "openai/gpt-4.1-mini", models: [] }));
    expect(loadConfig(dir)).toEqual({ enabled: true, model: "openai/gpt-4.1-mini" });
  });

  test("reads per-model thinking levels from object entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "title-thinking-"));
    writeFileSync(join(dir, "session-title.json"), JSON.stringify({
      models: [{ model: "mistral/mistral-medium-3.5", thinkingLevel: "high" }, { model: "openai/o4", thinkingLevel: "loud" }, "openai/gpt-4.1-mini"],
    }));
    expect(loadConfig(dir)).toEqual({
      enabled: true,
      model: "mistral/mistral-medium-3.5",
      models: ["mistral/mistral-medium-3.5", "openai/o4", "openai/gpt-4.1-mini"],
      thinking: { "mistral/mistral-medium-3.5": "high" },
    });
  });

  test("reads the refresh mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "title-refresh-"));
    writeFileSync(join(dir, "session-title.json"), JSON.stringify({ refresh: "once" }));
    expect(loadConfig(dir).refresh).toBe("once");
    writeFileSync(join(dir, "session-title.json"), JSON.stringify({ refresh: "always" }));
    expect(loadConfig(dir).refresh).toBeUndefined();
  });

  test("picks up edits within five seconds, re-reading only a changed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "title-watch-"));
    const file = join(dir, "session-title.json");
    let clock = 1_000;
    const current = watchConfig(dir, () => clock);
    expect(current()).toEqual({ enabled: true });
    writeFileSync(file, JSON.stringify({ enabled: false }));
    utimesSync(file, 1, 1);
    clock += 4_999;
    expect(current().enabled).toBe(true);
    clock += 1;
    expect(current().enabled).toBe(false);
    const cached = current();
    clock += 5_000;
    expect(current()).toBe(cached);
  });

  test("reads the independent Tab link switch", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-title-config-"));
    writeFileSync(join(dir, "session-title.json"), JSON.stringify({ enabled: false, tabLink: true }));
    expect(loadConfig(dir)).toEqual({ enabled: false, model: undefined, tabLink: true });
    writeFileSync(join(dir, "session-title.json"), JSON.stringify({ tabLink: false }));
    expect(loadConfig(dir).tabLink).toBe(false);
  });
});

describe("first request draft", () => {
  test("starts one plain title request from the first meaningful request", async () => {
    const h = setup();
    await firstTurn(h);
    expect(h.calls).toHaveLength(1);
    expect(h.pi.names).toEqual(["Generated Title"]);
    expect(h.calls[0].prompt).toContain("first_request: please fix the retry loop in fetch");
    expect(h.calls[0].systemPrompt).toBeUndefined();
    expect(states(h)).toEqual([{ version: 1, title: "Generated Title" }]);
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

  test("leaves a manually named session alone", async () => {
    const h = setup({ name: "Important Thing" });
    await firstTurn(h);
    await settle(h, "done");
    expect(h.calls).toHaveLength(0);
    expect(h.pi.name).toBe("Important Thing");
  });

  test("uses only the triggering user request", async () => {
    const h = setup();
    await firstTurn(h, "add hyperlinks to tool blocks");
    await prompt(h, "now add stats");
    const draft = h.calls[0].prompt as string;
    expect(draft).toContain("first_request: add hyperlinks to tool blocks");
    expect(draft).not.toContain("now add stats");
  });

  test("passes the configured model override", async () => {
    const h = setup({ config: config({ model: "openai/gpt-4.1-mini" }) });
    await firstTurn(h);
    expect(h.calls[0].override).toBe("openai/gpt-4.1-mini");
  });

  test("does not overwrite a name assigned elsewhere while generation is running", async () => {
    let finish!: (result: TitleResult) => void;
    const pending = new Promise<TitleResult>((resolve) => { finish = resolve; });
    const h = setup({ request: async () => pending });
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.emit("before_agent_start", { prompt: "redesign the footer" }, h.ctx);
    h.pi.setSessionName("My Name");
    await flushDetachedRequest();
    expect(h.calls[0].signal.aborted).toBe(true);
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
    await prompt(h, "hello");
    await settle(h, "Hi! How can I help?");
    expect(h.calls).toHaveLength(0);
    await prompt(h, "redesign the Pi footer");
    expect(h.calls).toHaveLength(1);
    expect(h.pi.name).toBe("Generated Title");
  });

  test("never titles automatically in a child agent process", async () => {
    const h = setup({ env: { PI_SUBAGENT_CHILD: "1" } });
    await firstTurn(h);
    await settle(h, "done");
    expect(h.calls).toHaveLength(0);
    expect(h.pi.name).toBeUndefined();
    await h.pi.commands.get("title").handler("status", h.ctx);
    expect(h.notifications.at(-1)!.message).toContain("automatic: off (child agent)");
  });

  test("passes ordered models and announces a fallback only once", async () => {
    const fallback = "mistral/mistral-medium-3.5 unavailable; used amazon-bedrock/opus-5";
    const h = setup({
      config: config({ model: "mistral/mistral-medium-3.5", models: ["mistral/mistral-medium-3.5", "openai/gpt-4.1-mini"] }),
      results: [{ title: "Fallback Title", model: "amazon-bedrock/opus-5", fallback }],
    });
    await firstTurn(h);
    expect(h.calls[0].overrides).toEqual(["mistral/mistral-medium-3.5", "openai/gpt-4.1-mini"]);
    expect(h.calls[0].override).toBe("mistral/mistral-medium-3.5");
    await h.pi.commands.get("title").handler("now", h.ctx);
    const notices = h.notifications.filter((notice) => notice.message.startsWith("Title model fallback"));
    expect(notices).toEqual([{ message: `Title model fallback: ${fallback}.`, level: "warning" }]);
    await h.pi.commands.get("title").handler("status", h.ctx);
    expect(h.notifications.at(-1)!.message).toContain("model: mistral/mistral-medium-3.5 → openai/gpt-4.1-mini → active session model");
    expect(h.notifications.at(-1)!.message).toContain(`last fallback: ${fallback}`);
  });

  test("warns again when the fallback route changes, and after the preferred model recovers", async () => {
    const h = setup({
      results: [
        { title: "A Title", fallback: "a/one unavailable; used b/two" },
        { title: "A Title", fallback: "a/one unavailable; used b/two" },
        { title: "A Title", fallback: "a/one unavailable; b/two failed; used active/model" },
        { title: "A Title" },
        { title: "A Title", fallback: "a/one unavailable; used b/two" },
      ],
    });
    await firstTurn(h);
    for (let index = 0; index < 4; index += 1) await h.pi.commands.get("title").handler("now", h.ctx);
    expect(h.notifications.filter((notice) => notice.level === "warning").map((notice) => notice.message)).toEqual([
      "Title model fallback: a/one unavailable; used b/two.",
      "Title model fallback: a/one unavailable; b/two failed; used active/model.",
      "Title model fallback: a/one unavailable; used b/two.",
    ]);
  });

  test("does nothing when disabled", async () => {
    const h = setup({ config: config({ enabled: false }) });
    await firstTurn(h);
    await settle(h, "done");
    expect(h.calls).toHaveLength(0);
    expect(h.pi.name).toBeUndefined();
  });

  test("--no-auto-title disables automatic titles but keeps /title now", async () => {
    const h = setup();
    expect(h.pi.flags.has("no-auto-title")).toBe(true);
    h.pi.flags.set("no-auto-title", true);
    await firstTurn(h);
    await settle(h, "done");
    expect(h.calls).toHaveLength(0);
    await h.pi.commands.get("title").handler("status", h.ctx);
    expect(h.notifications.at(-1)!.message).toContain("automatic: off (--no-auto-title)");
    await h.pi.commands.get("title").handler("now", h.ctx);
    expect(h.pi.name).toBe("Generated Title");
  });

  test("ignores empty prompts", async () => {
    const h = setup();
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.emit("before_agent_start", { prompt: "   " }, h.ctx);
    expect(h.pi.name).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });
});

describe("titles that follow the session", () => {
  const focused = (title: string, turn = `turn for ${title}`, focus = `focus for ${title}`): TitleResult =>
    ({ title, turn, focus, model: "m", usage: { input: 1, output: 1, cost: 0 } });

  test("retitles after each finished turn from requests, the answer, and the saved focus", async () => {
    const h = setup({ results: [{ title: "Retry Loop" }, focused("Fetch Retry Policy"), focused("Fetch Retry Policy")] });
    await firstTurn(h);
    await settle(h, "Rewrote the retry loop with backoff.");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].systemPrompt).toContain("durable objective");
    expect(focusPrompt(h.calls[1])).toMatchObject({
      is_new_session: true,
      current_request: "please fix the retry loop in fetch",
      current_outcome: "Rewrote the retry loop with backoff.",
      previous_title: null,
    });
    expect(h.pi.names).toEqual(["Retry Loop", "Fetch Retry Policy"]);

    await prompt(h, "also cap the total wait");
    await settle(h, "Capped at 30 seconds.");
    expect(focusPrompt(h.calls[2])).toMatchObject({
      is_new_session: false,
      current_request: "also cap the total wait",
      current_outcome: "Capped at 30 seconds.",
      session_anchor: "focus for Fetch Retry Policy",
      previous_focus: "focus for Fetch Retry Policy",
      recent_turns: ["turn for Fetch Retry Policy"],
      previous_title: "Fetch Retry Policy",
    });
    expect(h.pi.names).toEqual(["Retry Loop", "Fetch Retry Policy"]);
    expect(states(h).filter((state) => state.focus)).toHaveLength(2);
    expect(states(h).at(-1)).toMatchObject({ title: "Fetch Retry Policy", leaf: h.branch.findLast((entry) => entry.type === "message").id });
  });

  test("shows the footer badge only for the first title", async () => {
    const h = setup({ results: [focused("Fetch Retry Policy")] });
    await firstTurn(h);
    const badges = h.pi.emitted.length;
    await settle(h, "done");
    expect(h.calls).toHaveLength(2);
    expect(h.pi.emitted).toHaveLength(badges);
  });

  test("does not retitle when no message arrived since the last title", async () => {
    const h = setup({ results: [focused("Fetch Retry Policy")] });
    await firstTurn(h);
    await settle(h, "done");
    await h.pi.emit("agent_settled", {}, h.ctx);
    await flushDetachedRequest();
    expect(h.calls).toHaveLength(2);
  });

  test("a manual rename pauses updates until /title now", async () => {
    const h = setup({ results: [focused("Fetch Retry Policy")] });
    await firstTurn(h);
    await h.pi.emit("session_info_changed", { name: "Generated Title" }, h.ctx);
    await h.pi.emit("session_info_changed", { name: "My Own Name" }, h.ctx);
    await settle(h, "done");
    expect(h.calls).toHaveLength(1);
    await h.pi.commands.get("title").handler("status", h.ctx);
    expect(h.notifications.at(-1)!.message).toContain("automatic: paused (manual title; /title now resumes)");

    await h.pi.commands.get("title").handler("now", h.ctx);
    expect(h.pi.name).toBe("Fetch Retry Policy");
    await prompt(h, "and log retries");
    await settle(h, "Logged.");
    expect(h.calls).toHaveLength(3);
  });

  test("/title set and /rename pause updates", async () => {
    for (const command of [["title", "set My Name"], ["rename", "My Name"]] as const) {
      const h = setup({ results: [focused("Fetch Retry Policy")] });
      await firstTurn(h);
      await h.pi.commands.get(command[0]).handler(command[1], h.ctx);
      await flushDetachedRequest();
      await settle(h, "done");
      expect(h.calls).toHaveLength(1);
      expect(h.pi.name).toBe("My Name");
    }
  });

  test("restores the focus and keeps following titles it set after a restart", async () => {
    const h = setup({ name: "Fetch Retry Policy", results: [focused("Fetch Retry Policy")] });
    h.branch.push(userEntry("fix the retry loop"), assistantEntry("done"));
    h.pi.appendEntry("session-title:state", { version: 1, title: "Fetch Retry Policy", focus: "saved focus", turn: "saved turn", leaf: h.branch[1].id });
    await h.pi.emit("session_start", { reason: "resume" }, h.ctx);
    await h.pi.commands.get("title").handler("status", h.ctx);
    expect(h.notifications.at(-1)!.message).toContain("focus: saved focus");
    await prompt(h, "cap the wait");
    await settle(h, "Capped.");
    expect(focusPrompt(h.calls[0])).toMatchObject({ previous_focus: "saved focus", current_request: "cap the wait" });
  });

  test("a name that differs from the saved title stays manual after a restart", async () => {
    const h = setup({ name: "Hand Picked" });
    h.branch.push(userEntry("fix the retry loop"), assistantEntry("done"));
    h.pi.appendEntry("session-title:state", { version: 1, title: "Fetch Retry Policy", focus: "f", turn: "t" });
    await h.pi.emit("session_start", { reason: "resume" }, h.ctx);
    await prompt(h, "cap the wait");
    await settle(h, "Capped.");
    expect(h.calls).toHaveLength(0);
  });

  test("/reload retitles once when turns finished since the last saved title", async () => {
    const h = setup({ name: "Fetch Retry Policy", results: [focused("Fetch Retry Policy")] });
    h.branch.push(userEntry("fix the retry loop"), assistantEntry("done"));
    h.pi.appendEntry("session-title:state", { version: 1, title: "Fetch Retry Policy", focus: "f", turn: "t", leaf: h.branch[1].id });
    await h.pi.emit("session_start", { reason: "reload" }, h.ctx);
    expect(h.calls).toHaveLength(0);
    h.branch.push(userEntry("cap the wait"), assistantEntry("Capped."));
    await h.pi.emit("session_start", { reason: "reload" }, h.ctx);
    await h.pi.emit("session_start", { reason: "reload" }, h.ctx);
    await flushDetachedRequest();
    expect(h.calls).toHaveLength(1);
  });

  test("titles an unnamed resumed session after its next turn", async () => {
    const h = setup({ results: [focused("Fetch Retry Policy")] });
    h.branch.push(userEntry("prior substantive work"), assistantEntry("ok"));
    await h.pi.emit("session_start", {}, h.ctx);
    await prompt(h, "new work");
    expect(h.calls).toHaveLength(0);
    await settle(h, "done");
    expect(focusPrompt(h.calls[0])).toMatchObject({
      current_request: "new work",
      earlier_turns: [{ request: "prior substantive work", outcome: "ok" }],
    });
    expect(h.pi.name).toBe("Fetch Retry Policy");
  });

  test("once mode titles only the first request and never retries", async () => {
    const h = setup({ config: config({ refresh: "once" }), results: [{ error: "rate limited" }, { title: "Second Try" }] });
    await firstTurn(h);
    for (let turn = 0; turn < 3; turn += 1) {
      await prompt(h, `redesign part ${turn}`);
      await settle(h, "done");
    }
    await h.pi.emit("session_start", { reason: "reload" }, h.ctx);
    expect(h.calls).toHaveLength(1);
    expect(h.pi.name).toBeUndefined();
  });
});

describe("loading into an existing session", () => {
  test("recovers requests so /title now works immediately", async () => {
    const h = setup();
    h.branch.push(userEntry("hello"), userEntry("add hyperlinks"), userEntry("now add stats"));
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.commands.get("title").handler("now", h.ctx);
    expect(focusPrompt(h.calls[0]).current_request).toBe("hello add hyperlinks now add stats");
    expect(h.pi.name).toBe("Generated Title");
  });

  test("once mode does not retroactively title an unnamed resumed session", async () => {
    const h = setup({ config: config({ refresh: "once" }) });
    h.branch.push(userEntry("prior substantive work"));
    await h.pi.emit("session_start", {}, h.ctx);
    await prompt(h, "new work");
    await settle(h, "done");
    expect(h.calls).toHaveLength(0);
    expect(h.pi.name).toBeUndefined();
  });

  test("can title after a resumed branch that only contained greetings", async () => {
    const h = setup();
    h.branch.push(userEntry("hello"));
    await h.pi.emit("session_start", {}, h.ctx);
    await prompt(h, "redesign the footer");
    expect(h.calls).toHaveLength(1);
    expect(h.pi.name).toBe("Generated Title");
  });

  test("does not touch a named resumed session without a saved title", async () => {
    const h = setup({ name: "Existing name" });
    h.branch.push(userEntry("a substantive request"));
    await h.pi.emit("session_start", {}, h.ctx);
    await settle(h, "done");
    expect(h.calls).toHaveLength(0);
  });

  test("ignores custom, image-only, and leading assistant entries", async () => {
    const h = setup();
    h.branch.push(
      assistantEntry("reply"),
      { type: "custom", customType: "x", data: {} },
      { type: "message", id: "img", message: { role: "user", content: [{ type: "image", data: "..." }] } },
      userEntry("real prompt"),
    );
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.commands.get("title").handler("now", h.ctx);
    expect(focusPrompt(h.calls[0])).toMatchObject({ current_request: "real prompt", current_outcome: null });
    expect(h.calls[0].prompt).not.toContain("reply");
  });
});

describe("/title", () => {
  test("status reports title, mode, and the last request", async () => {
    const h = setup();
    await firstTurn(h);
    await h.pi.commands.get("title").handler("status", h.ctx);
    const message = h.notifications.at(-1)!.message;
    expect(message).toContain("title: Generated Title");
    expect(message).toContain("automatic: after each turn");
    expect(message).toContain("$0.0002");
  });

  test("set applies a title and stops titling", async () => {
    const h = setup();
    await h.pi.emit("session_start", {}, h.ctx);
    await h.pi.commands.get("title").handler("set  My  Chosen Title ", h.ctx);
    expect(h.pi.name).toBe("My Chosen Title");
    await prompt(h, "redesign the footer");
    await settle(h, "done");
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

  test("now reports failures and needs at least one request", async () => {
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
  test("reports the refresh mode or why automatic titling is inactive", () => {
    expect(statusText({ config: config() })).toContain("automatic: after each turn");
    expect(statusText({ config: config({ refresh: "once" }) })).toContain("automatic: first request only");
    expect(statusText({ config: config(), automatic: "off" })).toContain("automatic: off");
  });
  test("shows the default model when none is configured", () => {
    expect(statusText({ config: config() })).toContain("model: mistral/mistral-medium-3.5 (if authenticated) → active session model");
  });
  test("surfaces the focus and the last error", () => {
    const text = statusText({ config: config(), focus: "Pi footer", last: { error: "no credentials" } });
    expect(text).toContain("focus: Pi footer");
    expect(text).toContain("last error: no credentials");
  });
});

test("resolves the agent directory through Pi rather than hardcoding .pi", () => {
  expect(agentDirectory()).toBe(getAgentDir());
});
