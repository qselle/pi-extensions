import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
import goalExtension from "../goal/index.ts";
import { createGoal, setGoalStatus } from "../goal/goal.ts";
import { GOAL_ATTENTION_EVENT, GOAL_CHANGED_EVENT } from "../goal/events.ts";
import notifyExtension from "./index.ts";
const root = await mkdtemp(join(tmpdir(), "pi-goal-notify-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
try {
  for (const reverse of [false, true]) {
    const notifications: string[] = [];
    const deliveryOwners: number[] = [];
    let installed = 0;
    let eventBus: any;
    const notify = (pi: any) => {
      const owner = ++installed;
      eventBus = pi.events;
      notifyExtension(pi, { deliver: (title) => { notifications.push(title); deliveryOwners.push(owner); } });
    };
    const manager = SessionManager.create(root, join(root, "sessions"));
    const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
      settingsManager: SettingsManager.inMemory({}), resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: reverse ? [notify, goalExtension] : [goalExtension, notify] } });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: getModels("anthropic")[0]! });
    let runner = session.extensionRunner;
    try {
      await session.bindExtensions({});
      await session.prompt("/goal Verify the feature");
      await runner.emit({ type: "agent_start" });
      await runner.emit({ type: "agent_settled" });
      assert.equal(notifications.length, 0, "active goals suppress routine pings");
      await session.prompt("/goal pause");
      await runner.emit({ type: "agent_start" });
      await runner.emit({ type: "agent_settled" });
      assert.equal(notifications.length, 1, "paused goals allow notifications");
      manager.appendCustomEntry("goal-state", { version: 2, goal: setGoalStatus(createGoal("Previously blocked goal"), "blocked") });
      await runner.emit({ type: "session_start", reason: "resume" });
      assert.equal(notifications.length, 1, "restored blocked goals never replay attention in either load order");
      manager.appendCustomEntry("goal-state", { version: 2, goal: createGoal("Restored goal") });
      await runner.emit({ type: "session_start", reason: "resume" });
      await runner.emit({ type: "agent_start" });
      await runner.emit({ type: "tool_execution_end", toolCallId: "failure", toolName: "bash", result: { content: [{ type: "text", text: "different failure" }] }, isError: true } as any);
      await runner.emit({ type: "agent_settled" });
      assert.equal(notifications.length, 1, "restored goals suppress notifications in either load order");
      eventBus.emit(GOAL_CHANGED_EVENT, { version: 1, status: "blocked" });
      const attention = { version: 1, attentionId: "blocked", sessionId: manager.getSessionId(), goalId: "goal", status: "blocked", turns: 3, tokensUsed: 10, tokenBudget: null };
      eventBus.emit(GOAL_ATTENTION_EVENT, { ...attention, sessionId: "different-session" });
      assert.equal(notifications.length, 1, "stale session attention cannot reach the current desktop");
      eventBus.emit(GOAL_ATTENTION_EVENT, attention);
      eventBus.emit(GOAL_ATTENTION_EVENT, attention);
      await runner.emit({ type: "agent_settled" });
      assert.equal(notifications.length, 2, "a blocked goal alerts once even before the turn settles");
      assert.match(notifications.at(-1)!, /input needed/);
      manager.appendCustomEntry("goal-state", { version: 2, goal: setGoalStatus(createGoal("Blocked at reload"), "blocked") });
      await session.reload();
      runner = session.extensionRunner;
      assert.equal(installed, 2, "native reload replaces the notification extension");
      assert.equal(notifications.length, 2, "native reload does not replay blocked attention");
      eventBus.emit(GOAL_ATTENTION_EVENT, { ...attention, attentionId: "usage", status: "usage_limited" });
      await runner.emit({ type: "agent_settled" });
      assert.equal(notifications.length, 3, "reloaded attention sends once and suppresses the settled ping");
      assert.equal(deliveryOwners.at(-1), installed, "only the current runtime can deliver attention");
    } finally { await runner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  }

  // Isolate terminal capability detection in this child process. No real banner,
  // bell, focus sequence, provider request, or configuration write is performed.
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const write = process.stdout.write;
  const terminal = process.env.TERM_PROGRAM;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.env.TERM_PROGRAM = "ghostty";
  try {
    const notifications: string[] = [];
    const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
      settingsManager: SettingsManager.inMemory({}), resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [(pi) => notifyExtension(pi, { deliver: (title) => notifications.push(title) })] } });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(root, join(root, "sessions")), model: getModels("anthropic")[0]! });
    const runner = session.extensionRunner;
    let input: ((data: string) => unknown) | undefined;
    runner.setUIContext({ ...runner.getUIContext(), onTerminalInput: (handler) => { input = handler; return () => { input = undefined; }; } }, "tui");
    const settle = async (text: string) => {
      await runner.emit({ type: "agent_start" });
      await runner.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }] } as any);
      await runner.emit({ type: "agent_settled" });
    };
    try {
      await runner.emit({ type: "session_start", reason: "startup" });
      await settle("unknown focus");
      assert.equal(notifications.length, 1, "missing focus reports must not silence notifications");
      assert.deepEqual(input!("\x1b[I"), { consume: true });
      await settle("focused");
      assert.equal(notifications.length, 1, "confirmed focus stays quiet");
      assert.deepEqual(input!("x\x1b[Oy"), { data: "xy" });
      await settle("unfocused");
      assert.equal(notifications.length, 2, "focus loss restores delivery and preserves ordinary input");
      await runner.emit({ type: "agent_start" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "failed", toolName: "bash", args: { command: "npm test" } });
      await runner.emit({ type: "tool_execution_end", toolCallId: "failed", toolName: "bash", result: { content: [{ type: "text", text: "Tests failed" }] }, isError: true });
      await runner.emit({ type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "test.ts" } });
      await runner.emit({ type: "tool_execution_end", toolCallId: "read", toolName: "read", result: {}, isError: false });
      await runner.emit({ type: "agent_settled" });
      assert.match(notifications.at(-1)!, /tool failed/, "unrelated read cannot hide a failed operation");
    } finally { await runner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  } finally {
    process.stdout.write = write;
    if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (terminal === undefined) delete process.env.TERM_PROGRAM; else process.env.TERM_PROGRAM = terminal;
  }
  console.log("native notification goal attention, focus fallback and failure recovery verified");
} finally { await rm(root, { recursive: true, force: true }); }
