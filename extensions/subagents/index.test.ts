import { afterEach, expect, test } from "bun:test";
import registerSubagents from "./index.ts";
import type { ChildContext } from "./context.ts";
import type { AgentClient, AgentClientOptions, RpcEvent } from "./rpc.ts";
import { SUBAGENT_STATE } from "./persistence.ts";

type Handler = (event: any, ctx: any) => unknown;

class FakeClient implements AgentClient {
  prompts: string[] = [];
  steers: string[] = [];
  starts = 0;
  stops = 0;
  private listeners = new Set<(event: RpcEvent) => void>();
  constructor(readonly options: AgentClientOptions) {}
  get pid() { return this.starts > this.stops ? 4242 : undefined; }
  async start() { this.starts++; }
  async prompt(message: string) { this.prompts.push(message); }
  async steer(message: string) { this.steers.push(message); }
  async abort() {}
  async clearQueue() {}
  async stop() { this.stops++; }
  onEvent(listener: (event: RpcEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onExit() { return () => {}; }
  stderr() { return ""; }
  emit(event: RpcEvent) { for (const listener of this.listeners) listener(event); }
  finish(text: string, extra: Record<string, unknown> = {}) {
    this.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra } });
    this.emit({ type: "agent_settled" });
  }
}

class MockPi {
  handlers = new Map<string, Handler[]>();
  tools = new Map<string, any>();
  entries: { type: "custom"; customType: string; data: any }[] = [];
  sent: { message: any; options: any }[] = [];
  events = { emit() {}, on() { return () => {}; } };
  on(event: string, handler: Handler) { this.handlers.set(event, [...this.handlers.get(event) ?? [], handler]); }
  registerTool(tool: any) { this.tools.set(tool.name, tool); }
  registerCommand() {}
  registerMessageRenderer() {}
  appendEntry(customType: string, data: unknown) { this.entries.push({ type: "custom", customType, data }); }
  sendMessage(message: unknown, options: unknown) { this.sent.push({ message, options }); }
  getThinkingLevel() { return "high"; }
  getActiveTools() { return ["read", "bash"]; }
  async emit(event: string, payload: unknown, ctx: unknown) {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
  }
  stateEntries() { return this.entries.filter((entry) => entry.customType === SUBAGENT_STATE); }
}

const childEnvironment = ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_PARENT_ID", "PI_SUBAGENT_PARENT_SESSION_ID"] as const;
const savedEnvironment = Object.fromEntries(childEnvironment.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of childEnvironment) {
    if (savedEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnvironment[key];
  }
});

async function setup() {
  // The parent side must load even when this test runs inside a child agent.
  for (const key of childEnvironment) delete process.env[key];
  const pi = new MockPi();
  const clients: FakeClient[] = [];
  let checkpointReads = 0;
  const createContext = async (_ctx: unknown, _mode: unknown, _summary?: string, resume?: unknown): Promise<ChildContext> => {
    const directory = `pi-subagent-context-${clients.length}`;
    return {
      directory,
      sessionFile: `${directory}/child.jsonl`,
      inheritedMessages: 0,
      initialEntryCount: 0,
      cleanup: async () => {},
      checkpoint: () => ({ directory, file: "child.jsonl", initialEntryCount: resume ? 1 : 0, leafId: `leaf-${++checkpointReads}` }),
    };
  };
  const coordinator = registerSubagents(pi as any, {
    createClient: (options) => { const client = new FakeClient(options); clients.push(client); return client; },
    createContext: createContext as any,
    registerCard: (() => ({ invalidate() {}, unregister() {} })) as any,
  })!;
  const ctx = {
    cwd: "/tmp/project",
    mode: "print",
    hasUI: false,
    model: { provider: "test", id: "model" },
    sessionManager: { getBranch: () => pi.entries, getSessionFile: () => undefined, getSessionId: () => "parent", getLeafId: () => null },
    ui: { notify() {} },
  };
  await pi.emit("session_start", { reason: "startup" }, ctx);
  const tool = pi.tools.get("subagents");
  const call = (args: Record<string, unknown>, signal?: AbortSignal) =>
    tool.execute("call", tool.prepareArguments ? tool.prepareArguments(args) : args, signal, undefined, ctx);
  return { pi, ctx, tool, call, clients, coordinator, reads: () => checkpointReads };
}

test("child tool activity appends no subagent state between lifecycle transitions", async () => {
  const { pi, call, clients, reads } = await setup();
  await call({ action: "spawn", name: "Busy", task: "Run many tools" });
  expect(pi.stateEntries()).toHaveLength(1);
  const readsAfterSpawn = reads();
  for (let index = 0; index < 40; index++) {
    clients[0]!.emit({ type: "tool_execution_start", toolName: "bash", args: { command: `step ${index}` } });
    clients[0]!.emit({ type: "tool_execution_end", toolName: "bash", isError: false, result: {} });
  }
  clients[0]!.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "toolUse" } });
  expect(pi.stateEntries(), "tool events do not append state").toHaveLength(1);
  expect(reads(), "tool events do not reread the child session").toBe(readsAfterSpawn);
  clients[0]!.finish("Done");
  expect(pi.stateEntries()).toHaveLength(2);
  expect(pi.stateEntries().at(-1)!.data.agents[0].agent.status).toBe("completed");
  await pi.emit("session_shutdown", { reason: "quit" }, {});
});
