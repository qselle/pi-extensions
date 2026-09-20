import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
import goalExtension from "../goal/index.ts";
import { createGoal } from "../goal/goal.ts";
import notifyExtension from "./index.ts";
const root = await mkdtemp(join(tmpdir(), "pi-goal-notify-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
try {
  for (const reverse of [false, true]) {
    const notifications: string[] = [];
    const notify = (pi: any) => notifyExtension(pi, { deliver: (title) => notifications.push(title) });
    const manager = SessionManager.create(root, join(root, "sessions"));
    const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
      settingsManager: SettingsManager.inMemory({}), resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: reverse ? [notify, goalExtension] : [goalExtension, notify] } });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: getModels("anthropic")[0]! });
    const runner = session.extensionRunner;
    try {
      await runner.emit({ type: "session_start", reason: "startup" });
      await session.prompt("/goal Verify the feature");
      await runner.emit({ type: "agent_start" });
      await runner.emit({ type: "agent_settled" });
      assert.equal(notifications.length, 0, "active goals suppress routine pings");
      await session.prompt("/goal pause");
      await runner.emit({ type: "agent_start" });
      await runner.emit({ type: "agent_settled" });
      assert.equal(notifications.length, 1, "paused goals allow notifications");
      manager.appendCustomEntry("goal-state", { version: 2, goal: createGoal("Restored goal") });
      await runner.emit({ type: "session_start", reason: "resume" });
      await runner.emit({ type: "agent_start" });
      await runner.emit({ type: "tool_execution_end", toolCallId: "failure", toolName: "bash", result: { content: [{ type: "text", text: "different failure" }] }, isError: true } as any);
      await runner.emit({ type: "agent_settled" });
      assert.equal(notifications.length, 1, "restored goals suppress notifications in either load order");
    } finally { await runner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  }
  console.log("goal notification suppression verified in both native extension load orders");
} finally { await rm(root, { recursive: true, force: true }); }
