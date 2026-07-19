import { expect, test } from "bun:test";
import {
  SubagentCoordinator,
  type AgentRuntime,
  type SpawnRequest,
} from "./coordinator.ts";
import type { AgentClient, RpcEvent } from "./rpc.ts";

class FakeClient implements AgentClient {
  startCalls = 0;
  promptCalls: string[] = [];
  steerCalls: string[] = [];
  abortCalls = 0;
  stopCalls = 0;
  startGate?: Promise<void>;
  private eventListeners = new Set<(event: RpcEvent) => void>();
  private exitListeners = new Set<(error: Error) => void>();

  async start() { this.startCalls++; await this.startGate; }
  async prompt(message: string) { this.promptCalls.push(message); }
  async steer(message: string) { this.steerCalls.push(message); }
  async abort() { this.abortCalls++; }
  async stop() { this.stopCalls++; }
  onEvent(listener: (event: RpcEvent) => void) { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  onExit(listener: (error: Error) => void) { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }
  stderr() { return ""; }
  emit(event: RpcEvent) { for (const listener of this.eventListeners) listener(event); }
  exit(error: Error) { for (const listener of this.exitListeners) listener(error); }
}

function harness(maxOpenAgents = 6) {
  const clients = new Map<string, FakeClient>();
  const cleanups = new Map<string, number>();
  const completions: string[] = [];
  const coordinator = new SubagentCoordinator({
    maxOpenAgents,
    createRuntime: async (request: SpawnRequest): Promise<AgentRuntime> => {
      const client = new FakeClient();
      clients.set(request.name, client);
      return {
        client,
        cleanup: async () => { cleanups.set(request.name, (cleanups.get(request.name) ?? 0) + 1); },
      };
    },
    hooks: { onCompletion: (agent) => { completions.push(agent.name); } },
  });
  coordinator.startSession();
  return { coordinator, clients, cleanups, completions };
}

const request = (name: string): SpawnRequest => ({
  name,
  task: `Investigate ${name}`,
  contextMode: "fresh",
  cwd: "/tmp/project",
  model: "test/model",
  thinking: "high",
});

test("reserves names and capacity before concurrent asynchronous startup", async () => {
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const clients = new Map<string, FakeClient>();
  const coordinator = new SubagentCoordinator({
    maxOpenAgents: 2,
    createRuntime: async (spawn) => {
      const gate = deferred();
      gates.set(spawn.name, gate);
      await gate.promise;
      const client = new FakeClient();
      clients.set(spawn.name, client);
      return { client, cleanup: async () => {} };
    },
  });
  coordinator.startSession();

  const first = coordinator.spawn(request("API audit"));
  const second = coordinator.spawn(request("Test audit"));
  await waitUntil(() => gates.size === 2);
  await expect(coordinator.spawn(request("Third task"))).rejects.toThrow("At most 2");
  await expect(coordinator.spawn(request("api AUDIT"))).rejects.toThrow("already exists");

  gates.get("API audit")!.resolve();
  gates.get("Test audit")!.resolve();
  await Promise.all([first, second]);
  expect(coordinator.list().map((agent) => agent.name).sort()).toEqual(["API audit", "Test audit"]);
  await coordinator.shutdown();
});

test("supports persistent follow-ups, interrupt, usage, and close", async () => {
  const { coordinator, clients, cleanups, completions } = harness();
  await coordinator.spawn(request("Reviewer"));
  const client = clients.get("Reviewer")!;
  expect(client.promptCalls).toHaveLength(1);

  client.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Initial review complete" }],
      provider: "test",
      model: "model",
      stopReason: "stop",
      usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, cost: { total: 0.01 } },
    },
  });
  client.emit({ type: "agent_settled" });
  await flushMicrotasks();
  expect(completions).toEqual(["Reviewer"]);
  expect(coordinator.list()[0]).toMatchObject({
    status: "completed",
    output: "Initial review complete",
    model: "test/model",
    thinking: "high",
  });
  expect(coordinator.list()[0].usage).toMatchObject({ input: 100, output: 20, cacheRead: 30, turns: 1 });

  const followed = await coordinator.send("reviewer", "Check the new tests");
  expect(followed.status).toBe("running");
  expect(client.promptCalls.at(-1)).toBe("Check the new tests");
  await coordinator.interrupt("Reviewer");
  expect(client.abortCalls).toBe(1);

  const closed = await coordinator.close("Reviewer");
  expect(closed.status).toBe("closed");
  expect(client.stopCalls).toBe(1);
  expect(cleanups.get("Reviewer")).toBe(1);
});

test("wait owns matching completions while unrelated children still notify automatically", async () => {
  const { coordinator, clients, completions } = harness();
  await coordinator.spawn(request("One"));
  await coordinator.spawn(request("Two"));

  const waiting = coordinator.wait(["One", "Two"], 1_000, "any");
  await Promise.resolve();
  clients.get("One")!.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "one result" }], stopReason: "stop" } });
  clients.get("One")!.emit({ type: "agent_settled" });
  const result = await waiting;
  await flushMicrotasks();

  expect(result.timedOut).toBe(false);
  expect(result.agents.find((agent) => agent.name === "One")?.status).toBe("completed");
  expect(result.agents.find((agent) => agent.name === "Two")?.status).toBe("running");
  expect(completions).toEqual([]);

  clients.get("Two")!.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "two result" }], stopReason: "stop" } });
  clients.get("Two")!.emit({ type: "agent_settled" });
  await flushMicrotasks();
  expect(completions).toEqual(["Two"]);
  await coordinator.shutdown();
});

test("wait cancellation does not terminate the child", async () => {
  const { coordinator, clients } = harness();
  await coordinator.spawn(request("Long task"));
  const controller = new AbortController();
  const waiting = coordinator.wait(["Long task"], 10_000, "all", controller.signal);
  controller.abort();
  const result = await waiting;
  expect(result.interrupted).toBe(true);
  expect(clients.get("Long task")!.stopCalls).toBe(0);
  expect(coordinator.list()[0].status).toBe("running");
  await coordinator.shutdown();
});

test("cancels startup that outlives parent shutdown and cleans its runtime", async () => {
  const gate = deferred();
  const client = new FakeClient();
  let cleanups = 0;
  const coordinator = new SubagentCoordinator({
    createRuntime: async () => {
      await gate.promise;
      return { client, cleanup: async () => { cleanups++; } };
    },
  });
  coordinator.startSession();
  const spawning = coordinator.spawn(request("Late child"));
  await Promise.resolve();
  await coordinator.shutdown();
  gate.resolve();
  await expect(spawning).rejects.toThrow("Parent session ended");
  expect(client.stopCalls).toBe(1);
  expect(cleanups).toBe(1);
});

test("keeps a bounded transcript snapshot after child cleanup", async () => {
  const client = new FakeClient();
  let entries: unknown[] = Array.from({ length: 520 }, (_, index) => ({ type: "message", index }));
  const coordinator = new SubagentCoordinator({
    createRuntime: async () => ({
      client,
      transcript: () => entries,
      cleanup: async () => { entries = []; },
    }),
  });
  coordinator.startSession();
  await coordinator.spawn(request("Transcript child"));
  const live = coordinator.transcript("Transcript child");
  expect(live.entries).toHaveLength(500);
  expect((live.entries[0] as any).index).toBe(20);

  await coordinator.close("Transcript child");
  const retained = coordinator.transcript("Transcript child");
  expect(retained.agent.status).toBe("closed");
  expect(retained.entries).toHaveLength(500);
  expect((retained.entries.at(-1) as any).index).toBe(519);
});

test("converts unexpected process exits into bounded failed completions", async () => {
  const { coordinator, clients, completions, cleanups } = harness();
  await coordinator.spawn(request("Crash test"));
  clients.get("Crash test")!.exit(new Error("provider connection lost"));
  await waitUntil(() => coordinator.list()[0]?.status === "failed");
  await flushMicrotasks();
  expect(coordinator.list()[0].error).toContain("provider connection lost");
  expect(completions).toEqual(["Crash test"]);
  expect(cleanups.get("Crash test")).toBe(1);
  await coordinator.shutdown();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("Timed out waiting for condition");
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
