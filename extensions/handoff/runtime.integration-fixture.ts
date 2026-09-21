import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  SessionManager, type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

const root = await mkdtemp(join(tmpdir(), "pi-handoff-runtime-"));
const factory: CreateAgentSessionRuntimeFactory = async (options) => {
  const services = await createAgentSessionServices({
    cwd: options.cwd, agentDir: options.agentDir,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
  });
  const result = await createAgentSessionFromServices({ services, sessionManager: options.sessionManager, noTools: "all" });
  return { ...result, services, diagnostics: [] };
};
let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
try {
  const parent = SessionManager.create(root, join(root, "sessions"));
  parent.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
  parent.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }],
    api: "openai-completions", provider: "test", model: "test", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  parent.appendMessage({ role: "user", content: "finish the complete task", timestamp: Date.now() });
  const { default: extension } = await import("./index.ts");
  const { createGoal } = await import("../goal/goal.ts");
  const goal = { version: 2, goal: { ...createGoal("finish the complete task", { tokenBudget: 50000 }), tokensUsed: 1234 } };
  parent.appendCustomEntry("goal-state", goal);
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function>();
  const notices: string[] = [];
  extension({ registerCommand: (name: string, value: any) => commands.set(name, value), registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: Function) => handlers.set(name, handler), appendEntry: (type: string, data: unknown) => parent.appendCustomEntry(type, data), events: { emit() {} } } as never);
  runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir: join(root, "agent"), sessionManager: parent });
  let idle = true; let pending = false; let switches = 0;
  const ctx: any = { mode: "json", cwd: root, sessionManager: parent, isIdle: () => idle, hasPendingMessages: () => pending,
    ui: { notify: (message: string) => notices.push(message) },
    newSession: async (options: any) => { switches++; return runtime!.newSession(options); } };
  const command = commands.get("handoff");
  await command.handler("new", ctx);
  assert(notices.at(-1)!.includes("No handoff"));
  await tools.get("prepare_handoff").execute("prepare", { summary: "Objective: finish the complete task. Verified: tests passed. Remaining: review changes.", next_prompt: "Continue from verified files." }, undefined, undefined, ctx);
  idle = false; await command.handler("new", ctx); idle = true;
  pending = true; await command.handler("new", ctx); pending = false;
  assert.equal(switches, 0);
  parent.appendMessage({ role: "user", content: "also preserve constraints", timestamp: Date.now() });
  await command.handler("new", ctx);
  assert(notices.at(-1)!.includes("stale"));
  assert.equal(switches, 0);
  await tools.get("prepare_handoff").execute("prepare2", { summary: "Objective: finish the complete task and preserve constraints. Verified: tests passed. Remaining: review changes." }, undefined, undefined, ctx);
  const checkpointCount = () => parent.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === "handoff-checkpoint").length;
  const beforeEdit = checkpointCount();
  await command.handler("edit", { ...ctx, mode: "tui", ui: { ...ctx.ui, editor: async () => undefined } });
  assert.equal(checkpointCount(), beforeEdit);
  await command.handler("edit", { ...ctx, mode: "tui", ui: { ...ctx.ui, editor: async () => {
    parent.appendMessage({ role: "user", content: "new instruction while editing", timestamp: Date.now() });
    return "outdated edited summary";
  } } });
  assert.equal(checkpointCount(), beforeEdit);
  assert(notices.at(-1)!.includes("session changed"));
  await command.handler("edit", { ...ctx, mode: "tui", ui: { ...ctx.ui, editor: async () => "Objective: finish the complete task, preserve constraints and include the newest instruction. Remaining: review files." } });
  assert.equal(checkpointCount(), beforeEdit + 1);
  await command.handler("new", { ...ctx, newSession: async () => ({ cancelled: true }) });
  assert.equal(switches, 0);
  const originalPath = parent.getSessionFile()!;
  const original = await readFile(originalPath, "utf8");
  await command.handler("new", ctx);
  assert.equal(switches, 1);
  const manager = runtime.session.sessionManager;
  assert.notEqual(manager.getSessionId(), parent.getSessionId());
  assert.equal(manager.getHeader()!.parentSession, originalPath);
  const freshText = JSON.stringify(manager.buildSessionContext().messages);
  assert(freshText.includes("preserve constraints"));
  assert(!freshText.includes("first prompt"));
  assert(!freshText.includes("first answer"));
  const restored = manager.getBranch().find((entry: any) => entry.type === "custom" && entry.customType === "goal-state") as any;
  assert.deepEqual(JSON.parse(JSON.stringify(restored.data)), goal);
  assert.equal(await readFile(originalPath, "utf8"), original);
  // Pi flushes a new session when its first real assistant message arrives.
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "I will verify the files first." }],
    api: "openai-completions", provider: "test", model: "test", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const reopened = SessionManager.open(manager.getSessionFile()!);
  assert(JSON.stringify(reopened.buildSessionContext().messages).includes("preserve constraints"));
  console.log("handoff guards, real session replacement, workflow state and persistence verified");
} finally {
  runtime?.session.dispose();
  await rm(root, { recursive: true, force: true });
}
