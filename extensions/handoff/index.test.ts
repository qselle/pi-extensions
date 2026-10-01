import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension, { CURRENT_PANE } from "./index.ts";
import { HANDOFF_MESSAGE, START_PROMPT } from "./session.ts";

const IN_HERDR = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" };
const SUMMARY = "## Context\nThe telegram polling test is flaky.";
const TASK = "fix the flaky test";

interface Options {
  env?: Record<string, string>;
  choice?: string;
  /** Whether the simulated model answers the /handoff request with a tool call. */
  callsTool?: boolean;
  idle?: boolean;
  empty?: boolean;
  busy?: number;
  startError?: string;
  closeFails?: boolean;
}

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const ok = (payload: unknown) => ({ stdout: JSON.stringify(payload), stderr: "", code: 0 });
const herdrError = (code: string, message: string) => ({ stdout: "", stderr: JSON.stringify({ error: { code, message } }), code: 1 });

function harness(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-test-"));
  roots.push(root);
  const parent = SessionManager.create(root, join(root, "sessions"));
  if (!options.empty) parent.appendMessage({ role: "user", content: "fix things", timestamp: Date.now() });
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const calls: string[][] = [];
  const notices: Array<{ text: string; type: string }> = [];
  const selects: Array<{ title: string; items: string[] }> = [];
  const sent: any[] = [];
  const results: string[] = [];
  const errors: string[] = [];
  const replaced: Array<{ parentSession?: string; session: SessionManager }> = [];
  const started: string[] = [];
  let busy = options.busy ?? 0;
  let turn: Promise<void> = Promise.resolve();

  const ui = {
    select: async (title: string, items: string[]) => { selects.push({ title, items }); return options.choice; },
    notify: (text: string, type: string) => notices.push({ text, type }),
  };
  const ctx: any = {
    cwd: root, hasUI: true, model: { provider: "anthropic", id: "claude-test" }, sessionManager: parent, ui,
    isIdle: () => options.idle ?? true, hasPendingMessages: () => false, waitForIdle: () => turn,
    async newSession(request: any) {
      const session = SessionManager.inMemory(root);
      await request.setup(session);
      replaced.push({ parentSession: request.parentSession, session });
      await request.withSession({ ui, sendUserMessage: async (text: string) => { started.push(text); } });
      return { cancelled: false };
    },
  };
  const exec = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "pane" && args[1] === "split") return ok({ result: { pane: { pane_id: "w1:p2" } } });
    if (args[0] === "tab") return ok({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p3" } } });
    if (args[0] === "workspace" && args[1] === "create") return ok({ result: { workspace: { workspace_id: "w2" }, root_pane: { pane_id: "w2:p1" } } });
    if (args[0] === "agent") {
      if (busy-- > 0) return herdrError("agent_pane_busy", "pane is busy");
      if (options.startError) return herdrError("agent_start_timeout", options.startError);
    }
    if (args[1] === "close" && options.closeFails) return herdrError("close_failed", "cannot close");
    return ok({ result: {} });
  };
  const callTool = async (params: { summary: string; task?: string }) => {
    try {
      const output = await tools.get("handoff").execute("call", params, undefined, undefined, ctx);
      results.push(output.content[0].text);
    } catch (error) {
      errors.push((error as Error).message);
    }
  };
  extension({
    registerCommand: (name: string, value: unknown) => commands.set(name, value),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on() {},
    getThinkingLevel: () => "high",
    getSessionName: () => "Parent title",
    sendMessage(message: unknown, sendOptions: unknown) {
      sent.push({ message, options: sendOptions });
      if (options.callsTool !== false) turn = callTool({ summary: SUMMARY, task: "model's own wording" });
    },
  } as never, { env: options.env ?? IN_HERDR, exec, sleep: async () => {} });

  const startArgs = () => calls.filter((args) => args[0] === "agent").at(-1) ?? [];
  return {
    calls, notices, selects, sent, results, errors, replaced, started, callTool,
    parentFile: parent.getSessionFile()!,
    run: (args = "") => commands.get("handoff").handler(args, ctx),
    startArgs,
    childFile: () => startArgs()[startArgs().indexOf("--session") + 1],
  };
}

function handoffMessage(session: SessionManager): any {
  return session.getEntries().find((entry: any) => entry.type === "custom_message" && entry.customType === HANDOFF_MESSAGE);
}

test("hands a task off to a new Herdr pane that starts from the summary, not the history", async () => {
  const h = harness({ choice: "New pane below" });
  await h.run(TASK);

  expect(h.selects[0].items).toEqual([CURRENT_PANE, "New pane to the right", "New pane below", "New tab", "New workspace"]);
  expect(h.sent[0].options).toEqual({ triggerTurn: true });
  expect(h.sent[0].message.content).toContain(TASK);
  expect(h.calls[0]).toEqual(["pane", "split", "--current", "--direction", "down", "--cwd", expect.any(String), "--focus"]);
  expect(h.startArgs()).toEqual(["agent", "start", expect.stringMatching(/^handoff-[a-z0-9]{8}$/), "--kind", "pi", "--pane", "w1:p2", "--timeout", "30000", "--", "--session", h.childFile(), START_PROMPT]);

  const child = SessionManager.open(h.childFile());
  expect(child.getHeader()?.parentSession).toBe(h.parentFile);
  const context = child.buildSessionContext();
  expect(context.model).toEqual({ provider: "anthropic", modelId: "claude-test" });
  expect(context.thinkingLevel).toBe("high");
  expect(context.messages).toHaveLength(1);
  const message = handoffMessage(child);
  expect(message.display).toBe(true);
  // The user's task wins over the model's wording.
  expect(message.content).toContain(`which will not work on it: ${TASK}`);
  expect(message.content).toContain(h.parentFile);
  expect(message.content).toContain(SUMMARY);

  expect(h.results[0]).toContain(`Handed off "${TASK}" to a new session in new pane w1:p2`);
  expect(h.results[0]).toContain("owns it now");
  expect(h.replaced).toEqual([]);
});

test("switches the current pane to a summary-seeded session and starts only a given task", async () => {
  const withTask = harness({ choice: CURRENT_PANE });
  await withTask.run(TASK);
  expect(withTask.calls).toEqual([]);
  expect(withTask.results[0]).toContain("this pane switches");
  expect(withTask.replaced[0].parentSession).toBe(withTask.parentFile);
  expect(handoffMessage(withTask.replaced[0].session).content).toContain(SUMMARY);
  expect(withTask.started).toEqual([START_PROMPT]);

  const whole = harness({ choice: CURRENT_PANE });
  await whole.run();
  expect(whole.sent[0].message.content).toContain("this session's work");
  expect(handoffMessage(whole.replaced[0].session).content).toContain("You continue work handed off");
  expect(whole.started).toEqual([]);
});

test("outside Herdr, /handoff switches in place without asking", async () => {
  const h = harness({ env: {} });
  await h.run(TASK);
  expect(h.selects).toEqual([]);
  expect(h.replaced).toHaveLength(1);
});

test("hands nothing off when the model skips the tool, the run is busy, or the session is empty", async () => {
  const skipped = harness({ choice: "New tab", callsTool: false });
  await skipped.run(TASK);
  expect(skipped.notices[0]).toEqual({ text: "Nothing was handed off: the model did not call the handoff tool.", type: "warning" });
  expect(skipped.calls).toEqual([]);

  const busy = harness({ idle: false });
  await busy.run(TASK);
  expect(busy.sent).toEqual([]);
  expect(busy.notices[0].type).toBe("warning");

  const empty = harness({ empty: true });
  await empty.run(TASK);
  expect(empty.sent).toEqual([]);
  expect(empty.notices[0].text).toBe("Nothing to hand off yet.");
});

test("a direct tool call asks for a Herdr destination but never the current pane", async () => {
  const h = harness({ choice: "New tab" });
  await h.callTool({ summary: SUMMARY, task: "build the admin panel" });
  expect(h.selects[0].items).toEqual(["New pane to the right", "New pane below", "New tab", "New workspace"]);
  expect(h.calls[0]).toEqual(["tab", "create", "--workspace", "w1", "--cwd", expect.any(String), "--label", "build the admin panel", "--focus"]);
  expect(handoffMessage(SessionManager.open(h.childFile())).content).toContain("build the admin panel");

  const outside = harness({ env: {} });
  await outside.callTool({ summary: SUMMARY });
  expect(outside.errors[0]).toContain("run /handoff");
  expect(outside.calls).toEqual([]);
});

test("waits for a new pane's shell before starting Pi", async () => {
  const h = harness({ choice: "New workspace", busy: 2 });
  await h.run(TASK);
  expect(h.calls.filter((args) => args[0] === "agent")).toHaveLength(3);
  expect(h.results[0]).toContain("new workspace w2");
});

test("removes the new session when Pi does not start, unless Herdr cannot close its pane", async () => {
  const failed = harness({ choice: "New pane to the right", startError: "pi was not ready" });
  await failed.run(TASK);
  expect(failed.errors[0]).toContain("pi was not ready");
  expect(failed.calls.at(-1)).toEqual(["pane", "close", "w1:p2"]);
  expect(existsSync(failed.childFile())).toBe(false);

  const unclosed = harness({ choice: "New pane to the right", startError: "pi was not ready", closeFails: true });
  await unclosed.run(TASK);
  expect(existsSync(unclosed.childFile())).toBe(true);
});
