import { afterEach, expect, test } from "bun:test";
import registerSubagents from "./index.ts";
import type { ChildContext } from "./context.ts";
import type { AgentClient, AgentClientOptions, RpcEvent } from "./rpc.ts";
import { SUBAGENT_STATE } from "./persistence.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS } from "./arguments.ts";

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
  commands = new Map<string, any>();
  registerCommand(name: string, command: unknown) { this.commands.set(name, command); }
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
  const contextNames: (string | undefined)[] = [];
  const createContext = async (_ctx: unknown, _mode: unknown, _summary?: string, resume?: unknown, name?: string): Promise<ChildContext> => {
    contextNames.push(name);
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
  return { pi, ctx, tool, call, clients, coordinator, contextNames, reads: () => checkpointReads };
}

test("child sessions carry the subagent name and link to the parent session", async () => {
  const { call, clients, contextNames } = await setup();
  await call({ action: "spawn", name: "Scout", task: "Look" });
  expect(contextNames).toEqual(["Scout"]);
  expect(clients[0]!.options.env).toMatchObject({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_PARENT_SESSION_ID: "parent" });
});

test("aliases from other agent tool sets map onto the published schema", async () => {
  const { tool } = await setup();
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [{ action: "followup", agent_name: "Scout", message: "Continue" }, { action: "send", agent_name: "Scout", message: "Continue" }],
    [{ action: "message", agent_id: "Scout", message: "Note" }, { action: "queue", agent_name: "Scout", message: "Note" }],
    [{ action: "send", name: "Scout", message: "Go" }, { action: "send", name: "Scout", agent_name: "Scout", message: "Go" }],
    [{ action: "close", agent_names: ["Scout"] }, { action: "close", agent_names: ["Scout"], agent_name: "Scout" }],
    [{ action: "spawn", name: "Scout", task: "Look", context: "compacted" }, { action: "spawn", name: "Scout", task: "Look", context: "summary" }],
    [{ action: "spawn", name: "Scout", task: "Look", context: "forked" }, { action: "spawn", name: "Scout", task: "Look", context: "fork" }],
    [{ action: "wait", agent_ids: ["A", "B"], return_when: "all", wake_on: "final", timeout_ms: 1_200_000 },
      { action: "wait", agent_names: ["A", "B"], wait_mode: "all", wake_on: "final", timeout_ms: 1_200_000 }],
    [{ action: "wait", agent_name: "A", return_when: "any", wake_on: "any", timeout_ms: 7_200_000 },
      { action: "wait", agent_name: "A", agent_names: ["A"], wait_mode: "any", wake_on: "any", timeout_ms: MAX_WAIT_MS }],
    [{ action: "wait", timeout_ms: -5 }, { action: "wait", timeout_ms: 0 }],
  ];
  for (const [input, expected] of cases) {
    const prepared = tool.prepareArguments(input);
    expect(prepared).toEqual(expected);
    expect(validateToolArguments(tool, { type: "toolCall", id: "alias", name: "subagents", arguments: prepared })).toEqual(expected);
  }
  expect(tool.parameters.properties.timeout_ms.maximum).toBe(3_600_000);
});

test("followup steers or resumes; message steers a running child and otherwise queues", async () => {
  const { pi, call, clients } = await setup();
  await call({ action: "spawn", name: "Worker", task: "Work" });
  await call({ action: "followup", agent_name: "Worker", message: "Also check tests" });
  const steered = await call({ action: "message", agent_id: "worker", message: "Prefer the new API" });
  expect(steered.details.action).toBe("send");
  expect(clients[0]!.steers).toEqual(["Also check tests", "Prefer the new API"]);
  expect(pi.commands.get("agents").handler).toBe(pi.commands.get("subagents").handler);
  clients[0]!.finish("done");
  await Bun.sleep(0);
  const queued = await call({ action: "message", agent_id: "Worker", message: "Context for later" });
  expect(queued.details.action).toBe("queue");
  expect(clients.flatMap((client) => client.prompts)).toHaveLength(1);
  await call({ action: "followup", agent_name: "Worker", message: "Now continue" });
  expect(clients.at(-1)!.prompts).toEqual(["Context for later\n\nNow continue"]);
});

test("wait defaults to five minutes, clamps long timeouts and honours return_when all", async () => {
  const { call, clients, coordinator } = await setup();
  await call({ action: "spawn", name: "One", task: "First" });
  await call({ action: "spawn", name: "Two", task: "Second" });
  const seen: number[] = [];
  const original = coordinator.wait.bind(coordinator) as (...args: any[]) => ReturnType<typeof coordinator.wait>;
  (coordinator as any).wait = (names: string[] | undefined, timeout: number, ...rest: any[]) => { seen.push(timeout); return original(names, timeout, ...rest); };

  let returned = false;
  const waiting = call({ action: "wait", agent_ids: ["One", "Two"], return_when: "all" }).then((result: any) => { returned = true; return result; });
  clients[0]!.finish("one done");
  await Bun.sleep(5);
  expect(returned, "all waits for every selected final").toBe(false);
  clients[1]!.finish("two done");
  const result = await waiting;
  expect(result.details.agents.map((agent: any) => agent.status)).toEqual(["completed", "completed"]);
  expect(seen).toEqual([DEFAULT_WAIT_MS]);
  expect(DEFAULT_WAIT_MS).toBe(300_000);

  (coordinator as any).wait = (names: string[] | undefined, timeout: number, ...rest: any[]) => { seen.push(timeout); return original(names, 0, ...rest); };
  await call({ action: "wait", timeout_ms: 9_000_000 });
  expect(seen.at(-1)).toBe(MAX_WAIT_MS);
});

test("a timed-out wait tells the model not to stop healthy children", async () => {
  const { call, clients } = await setup();
  await call({ action: "spawn", name: "Slow", task: "Take a while" });
  const result = await call({ action: "wait", agent_name: "Slow", timeout_ms: 1 });
  expect(result.details.timedOut).toBe(true);
  expect(result.content[0].text).toStartWith("Wait timed out after 1 ms. A wait timeout is not a failure");
  expect(result.content[0].text).toContain("Do not interrupt, close, or ask healthy children to stop or finalize because a wait timed out");
  expect(clients[0]!.stops).toBe(0);
});

test("a rate-limited child pauses, stops its process and resumes the same session on send", async () => {
  const { pi, call, clients } = await setup();
  await call({ action: "spawn", name: "Limited", task: "Hit a quota" });
  clients[0]!.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit exceeded" } });
  clients[0]!.emit({ type: "agent_settled" });
  await Bun.sleep(0);
  expect(clients[0]!.stops, "settled child process hibernates").toBe(1);
  expect(pi.sent).toHaveLength(1);
  expect(pi.sent[0]!.message.details.status).toBe("paused");
  expect(pi.sent[0]!.message.content).toContain("use send to resume this child instead of spawning a replacement");
  const listed = await call({ action: "list" });
  expect(listed.content[0].text).toContain("Limited · fresh · paused");
  expect(pi.tools.get("subagents").promptGuidelines.join("\n")).toContain("resume it with subagents send instead of spawning a replacement");

  await call({ action: "send", agent_name: "Limited", message: "Limits reset" });
  expect(clients).toHaveLength(2);
  const session = (client: FakeClient) => client.options.args[client.options.args.indexOf("--session") + 1];
  expect(session(clients[1]!)).toBe(session(clients[0]!));
  expect(clients[1]!.prompts).toEqual(["Limits reset"]);
  await pi.emit("session_shutdown", { reason: "quit" }, {});
});

test("reopening delivers an unacknowledged final passively and only once", async () => {
  const { pi, ctx, call, clients } = await setup();
  await call({ action: "spawn", name: "Done", task: "Finish" });
  clients[0]!.finish("Final answer");
  await Bun.sleep(0);
  expect(pi.sent.map((sent) => sent.options)).toEqual([{ deliverAs: "steer", triggerTurn: true }]);
  // The live notification never reached the branch, so the result is still unread.
  await pi.emit("session_shutdown", { reason: "reload" }, ctx);
  await pi.emit("session_start", { reason: "reload" }, ctx);
  await Bun.sleep(0);
  expect(pi.sent).toHaveLength(2);
  expect(pi.sent[1]!.options).toEqual({ triggerTurn: false });
  expect(pi.sent[1]!.message.details).toMatchObject({ name: "Done", status: "completed", output: "Final answer" });

  (pi.entries as any[]).push({ type: "custom_message", customType: pi.sent[1]!.message.customType, details: pi.sent[1]!.message.details });
  await pi.emit("session_shutdown", { reason: "reload" }, ctx);
  await pi.emit("session_start", { reason: "reload" }, ctx);
  await Bun.sleep(0);
  expect(pi.sent, "branch evidence prevents a repeat").toHaveLength(2);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("interrupt keeps the child resumable without a completion message", async () => {
  const { pi, call, clients } = await setup();
  await call({ action: "spawn", name: "Long", task: "Work" });
  const result = await call({ action: "interrupt", agent_name: "Long" });
  clients[0]!.emit({ type: "agent_settled", aborted: true });
  await Bun.sleep(0);
  expect(result.content[0].text).toBe("Interrupted Long; send resumes its conversation.");
  expect(result.details.agents[0].status).toBe("interrupted");
  expect(pi.sent).toEqual([]);
  expect(pi.stateEntries().at(-1)!.data.agents[0].agent.status).toBe("interrupted");
  await pi.emit("session_shutdown", { reason: "quit" }, {});
});

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
