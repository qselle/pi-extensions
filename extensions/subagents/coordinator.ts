import type { ContextMode } from "./context.ts";
import type { AgentClient, RpcEvent } from "./rpc.ts";

export const DEFAULT_MAX_OPEN_AGENTS = 6;
export const MAX_AGENT_NAME_CHARS = 64;
export const MAX_TASK_CHARS = 16_000;
export const MAX_MESSAGE_CHARS = 16_000;
export const MAX_RESULT_BYTES = 24 * 1024;

export type AgentStatus = "starting" | "running" | "completed" | "failed" | "closed";
export type WaitMode = "any" | "all";

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface AgentSnapshot {
  id: string;
  name: string;
  task: string;
  contextMode: ContextMode;
  status: AgentStatus;
  cwd: string;
  model?: string;
  thinking?: string;
  startedAt: number;
  endedAt?: number;
  output: string;
  error?: string;
  activity: string[];
  usage: AgentUsage;
}

export interface SpawnRequest {
  name: string;
  task: string;
  contextMode: ContextMode;
  cwd: string;
  model?: string;
  thinking?: string;
  parentContext?: unknown;
}

export interface AgentRuntime {
  client: AgentClient;
  cleanup(): Promise<void>;
  transcript?(): unknown[];
}

export interface AgentTranscript {
  agent: AgentSnapshot;
  entries: unknown[];
}

export type AgentRuntimeFactory = (request: SpawnRequest, signal?: AbortSignal) => Promise<AgentRuntime>;

export interface CoordinatorHooks {
  onChange?(): void;
  onCompletion?(agent: AgentSnapshot): void | Promise<void>;
  onUsage?(message: any, agent: AgentSnapshot): void;
}

export interface CoordinatorOptions {
  createRuntime: AgentRuntimeFactory;
  maxOpenAgents?: number;
  hooks?: CoordinatorHooks;
  now?: () => number;
}

export interface WaitResult {
  agents: AgentSnapshot[];
  timedOut: boolean;
  interrupted: boolean;
  alreadyReportedIds: string[];
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface ManagedAgent extends AgentSnapshot {
  client?: AgentClient;
  cleanup: () => Promise<void>;
  cleanupDone: boolean;
  transcript?: () => unknown[];
  transcriptCache: unknown[];
  completion: Deferred;
  settled: boolean;
  waiters: number;
  delivery: "none" | "automatic" | "wait";
  suppressCompletion: boolean;
  generation: number;
  closing?: Promise<void>;
}

export class SubagentCoordinator {
  private readonly agents = new Map<string, ManagedAgent>();
  private readonly usedNames = new Set<string>();
  private readonly reservedNames = new Set<string>();
  private reservations = 0;
  private generation = 0;
  private active = false;
  private readonly maxOpenAgents: number;
  private readonly now: () => number;

  constructor(private readonly options: CoordinatorOptions) {
    this.maxOpenAgents = Math.max(1, Math.min(16, options.maxOpenAgents ?? DEFAULT_MAX_OPEN_AGENTS));
    this.now = options.now ?? Date.now;
  }

  startSession(): void {
    this.generation += 1;
    this.active = true;
    this.agents.clear();
    this.usedNames.clear();
    this.reservedNames.clear();
    this.reservations = 0;
    this.changed();
  }

  async spawn(request: SpawnRequest, signal?: AbortSignal): Promise<AgentSnapshot> {
    const normalized: SpawnRequest = {
      ...request,
      name: normalizeName(request.name),
      task: boundedInput(request.task, "spawn task", MAX_TASK_CHARS),
    };
    const reservation = this.reserve(normalized.name);
    let runtime: AgentRuntime | undefined;
    let agent: ManagedAgent | undefined;
    try {
      throwIfAborted(signal);
      runtime = await this.options.createRuntime(normalized, signal);
      this.assertGeneration(reservation.generation);
      throwIfAborted(signal);

      let id: string;
      do {
        id = `${slug(normalized.name)}-${Math.random().toString(36).slice(2, 8)}`;
      } while (this.agents.has(id));
      agent = {
        id,
        name: normalized.name,
        task: normalized.task,
        contextMode: normalized.contextMode,
        status: "starting",
        cwd: normalized.cwd,
        model: normalized.model,
        thinking: normalized.thinking,
        startedAt: this.now(),
        output: "",
        activity: [],
        usage: emptyUsage(),
        client: runtime.client,
        cleanup: runtime.cleanup,
        cleanupDone: false,
        transcript: runtime.transcript,
        transcriptCache: [],
        completion: deferred(),
        settled: false,
        waiters: 0,
        delivery: "none",
        suppressCompletion: false,
        generation: reservation.generation,
      };
      this.agents.set(id, agent);
      reservation.commit();
      this.attach(agent, runtime.client);
      this.changed();

      const abortStartup = () => void runtime?.client.stop().catch(() => undefined);
      signal?.addEventListener("abort", abortStartup, { once: true });
      try {
        await runtime.client.start();
        this.assertGeneration(reservation.generation);
        throwIfAborted(signal);
        agent.status = "running";
        await runtime.client.prompt(buildChildPrompt(normalized));
        this.assertGeneration(reservation.generation);
        throwIfAborted(signal);
      } finally {
        signal?.removeEventListener("abort", abortStartup);
      }
      this.changed();
      return this.snapshot(agent);
    } catch (error) {
      if (agent) {
        this.finish(agent, "failed", toError(error).message, true);
        await this.closeManaged(agent, true).catch((cleanupError) => {
          throw new AggregateError([error, cleanupError], "Subagent startup and cleanup failed");
        });
      } else if (runtime) {
        const failures = await Promise.allSettled([runtime.client.stop(), runtime.cleanup()]);
        const rejected = failures.filter((item): item is PromiseRejectedResult => item.status === "rejected");
        if (rejected.length > 0) throw new AggregateError([error, ...rejected.map((item) => item.reason)], "Subagent startup and cleanup failed");
      }
      throw error;
    } finally {
      reservation.release();
    }
  }

  async send(name: string, message: string): Promise<AgentSnapshot> {
    const agent = this.requireAgent(name);
    const client = agent.client;
    if (!client || agent.status === "closed") throw new Error(`Subagent ${agent.name} is closed`);
    const text = boundedInput(message, "send message", MAX_MESSAGE_CHARS);

    if (isActive(agent)) {
      try {
        await client.steer(text);
        pushActivity(agent, `steered: ${compact(text, 120)}`);
      } catch (error) {
        if (!isActive(agent) && agent.client === client) await this.startFollowUp(agent, client, text);
        else throw error;
      }
    } else {
      await this.startFollowUp(agent, client, text);
    }
    this.changed();
    return this.snapshot(agent);
  }

  async interrupt(name: string): Promise<AgentSnapshot> {
    const agent = this.requireAgent(name);
    if (!agent.client || agent.status === "closed") throw new Error(`Subagent ${agent.name} is closed`);
    if (!isActive(agent)) return this.snapshot(agent);
    await agent.client.abort();
    pushActivity(agent, "interrupt requested");
    this.changed();
    return this.snapshot(agent);
  }

  async wait(names: string[] | undefined, timeoutMs: number, mode: WaitMode, signal?: AbortSignal): Promise<WaitResult> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) throw new Error("timeout_ms must be a non-negative integer");
    const targets = names && names.length > 0
      ? unique(names.map((name) => this.requireAgent(name)))
      : this.ordered().filter(isActive);
    const running = targets.filter(isActive);
    for (const agent of running) agent.waiters += 1;
    let timedOut = false;
    let interrupted = false;
    try {
      if (running.length > 0 && timeoutMs > 0) {
        const pending = mode === "all"
          ? Promise.all(running.map((agent) => agent.completion.promise)).then(() => undefined)
          : Promise.race(running.map((agent) => agent.completion.promise));
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve();
          };
          const onAbort = () => {
            interrupted = true;
            finish();
          };
          const timer = setTimeout(() => {
            timedOut = true;
            finish();
          }, timeoutMs);
          pending.then(finish, finish);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      } else if (running.length > 0) {
        timedOut = true;
      }
    } finally {
      for (const agent of running) agent.waiters = Math.max(0, agent.waiters - 1);
    }

    const alreadyReportedIds = targets.filter((agent) => agent.delivery === "automatic").map((agent) => agent.id);
    for (const agent of targets) {
      if (!isActive(agent) && agent.delivery === "none") agent.delivery = "wait";
    }
    return {
      agents: targets.map((agent) => this.snapshot(agent)),
      timedOut,
      interrupted,
      alreadyReportedIds,
    };
  }

  list(): AgentSnapshot[] {
    return this.ordered().map((agent) => this.snapshot(agent));
  }

  transcript(name: string): AgentTranscript {
    const agent = this.requireAgent(name);
    this.captureTranscript(agent);
    return {
      agent: this.snapshot(agent),
      entries: structuredClone(agent.transcriptCache),
    };
  }

  async close(name: string): Promise<AgentSnapshot> {
    const agent = this.requireAgent(name);
    await this.closeManaged(agent, true);
    return this.snapshot(agent);
  }

  async shutdown(): Promise<void> {
    this.active = false;
    this.generation += 1;
    for (const agent of this.agents.values()) agent.suppressCompletion = true;
    const results = await Promise.allSettled([...this.agents.values()].map((agent) => this.closeManaged(agent, true)));
    this.agents.clear();
    this.reservedNames.clear();
    this.reservations = 0;
    this.changed();
    const errors = results.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason);
    if (errors.length > 0) throw new AggregateError(errors, "Failed to clean up one or more subagents");
  }

  private async startFollowUp(agent: ManagedAgent, client: AgentClient, message: string): Promise<void> {
    const previous = {
      status: agent.status,
      startedAt: agent.startedAt,
      endedAt: agent.endedAt,
      output: agent.output,
      error: agent.error,
      activity: [...agent.activity],
      completion: agent.completion,
      settled: agent.settled,
      delivery: agent.delivery,
    };
    agent.status = "running";
    agent.startedAt = this.now();
    agent.endedAt = undefined;
    agent.output = "";
    agent.error = undefined;
    agent.activity = [`follow-up: ${compact(message, 120)}`];
    agent.completion = deferred();
    agent.settled = false;
    agent.delivery = "none";
    agent.suppressCompletion = false;
    this.changed();
    try {
      await client.prompt(message);
    } catch (error) {
      agent.completion.resolve();
      Object.assign(agent, previous);
      this.changed();
      throw error;
    }
  }

  private attach(agent: ManagedAgent, client: AgentClient): void {
    client.onEvent((event) => this.handleEvent(agent, event));
    client.onExit((error) => {
      if (agent.client === client) agent.client = undefined;
      this.captureTranscript(agent);
      void agent.cleanup().then(
        () => {
          agent.cleanupDone = true;
          if (isActive(agent)) this.finish(agent, "failed", error.message);
          this.changed();
        },
        (cleanupError) => {
          const detail = `${error.message}; cleanup failed: ${toError(cleanupError).message}`;
          if (isActive(agent)) this.finish(agent, "failed", detail);
          else agent.error = boundedText(detail, 4 * 1024);
          this.changed();
        },
      );
    });
  }

  private handleEvent(agent: ManagedAgent, event: RpcEvent): void {
    if (agent.status === "closed") return;
    if (event.type === "agent_start") {
      agent.status = "running";
      this.changed();
      return;
    }
    if (event.type === "tool_execution_start") {
      const tool = typeof event.toolName === "string" ? event.toolName : "tool";
      const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
      const detail = typeof args.command === "string" ? `: ${compact(args.command, 100)}` : "";
      pushActivity(agent, `${tool}${detail}`);
      this.changed();
      return;
    }
    if (event.type === "message_end" && (event as any).message?.role === "assistant") {
      const message = (event as any).message;
      const text = assistantText(message);
      if (text) agent.output = boundedText(text, MAX_RESULT_BYTES);
      agent.usage.turns += 1;
      const usage = message.usage;
      if (usage) {
        agent.usage.input += positive(usage.input);
        agent.usage.output += positive(usage.output);
        agent.usage.cacheRead += positive(usage.cacheRead);
        agent.usage.cacheWrite += positive(usage.cacheWrite);
        agent.usage.cost += positive(usage.cost?.total);
      }
      if (typeof message.provider === "string" && typeof message.model === "string") {
        agent.model = `${message.provider}/${message.model}`;
      }
      agent.error = message.stopReason === "error" || message.stopReason === "aborted"
        ? boundedText(String(message.errorMessage || `Subagent ${message.stopReason}`), 4 * 1024)
        : undefined;
      this.options.hooks?.onUsage?.(message, this.snapshot(agent));
      this.changed();
      return;
    }
    if (event.type === "tool_execution_end") {
      this.changed();
      return;
    }
    if (event.type === "extension_error") {
      pushActivity(agent, `extension error: ${compact(String(event.error ?? "unknown"), 120)}`);
      this.changed();
      return;
    }
    if (event.type === "agent_settled") {
      this.finish(agent, agent.error ? "failed" : "completed", agent.error);
    }
  }

  private finish(agent: ManagedAgent, status: "completed" | "failed", error?: string, suppress = false): void {
    if (agent.settled || agent.status === "closed") return;
    agent.settled = true;
    agent.status = status;
    agent.endedAt = this.now();
    if (error) agent.error = boundedText(sanitize(error), 4 * 1024);
    if (suppress) agent.suppressCompletion = true;
    agent.completion.resolve();
    this.changed();
    queueMicrotask(() => void this.deliverCompletion(agent));
  }

  private async deliverCompletion(agent: ManagedAgent): Promise<void> {
    if (!this.active || agent.generation !== this.generation || agent.suppressCompletion || agent.waiters > 0 || agent.delivery !== "none" || agent.status === "closed") return;
    agent.delivery = "automatic";
    try {
      await this.options.hooks?.onCompletion?.(this.snapshot(agent));
    } catch {
      agent.delivery = "none";
    }
  }

  private closeManaged(agent: ManagedAgent, suppressCompletion: boolean): Promise<void> {
    agent.suppressCompletion ||= suppressCompletion;
    if (agent.closing) return agent.closing;
    if (agent.status === "closed" && !agent.client && agent.cleanupDone) return Promise.resolve();
    agent.status = "closed";
    agent.endedAt ??= this.now();
    if (!agent.settled) {
      agent.settled = true;
      agent.completion.resolve();
    }
    this.changed();
    const client = agent.client;
    const operation = (async () => {
      const failures: unknown[] = [];
      if (client) {
        try {
          await client.stop();
          if (agent.client === client) agent.client = undefined;
        } catch (error) {
          failures.push(error);
        }
      }
      if (!agent.cleanupDone) {
        this.captureTranscript(agent);
        try {
          await agent.cleanup();
          agent.cleanupDone = true;
        } catch (error) {
          failures.push(error);
        }
      }
      this.changed();
      if (failures.length > 0) throw new AggregateError(failures, `Failed to close subagent ${agent.name}`);
    })();
    agent.closing = operation;
    return operation.finally(() => {
      if (agent.closing === operation) agent.closing = undefined;
    });
  }

  private reserve(name: string): { generation: number; commit(): void; release(): void } {
    if (!this.active) throw new Error("Cannot spawn a subagent outside an active parent session");
    const key = name.toLocaleLowerCase();
    if (this.usedNames.has(key) || this.reservedNames.has(key)) throw new Error(`Subagent name already exists: ${name}`);
    if (this.openCount() + this.reservations >= this.maxOpenAgents) {
      throw new Error(`At most ${this.maxOpenAgents} subagents may remain open; close one before spawning another`);
    }
    this.reservations += 1;
    this.reservedNames.add(key);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.reservations = Math.max(0, this.reservations - 1);
      this.reservedNames.delete(key);
    };
    return {
      generation: this.generation,
      commit: () => {
        if (!released) this.usedNames.add(key);
        release();
      },
      release,
    };
  }

  private requireAgent(name: string): ManagedAgent {
    const key = normalizeLookup(name).toLocaleLowerCase();
    const agent = [...this.agents.values()].find((candidate) => candidate.name.toLocaleLowerCase() === key || candidate.id === name);
    if (!agent) throw new Error(`Subagent not found: ${name}`);
    return agent;
  }

  private assertGeneration(expected: number): void {
    if (!this.active || this.generation !== expected) throw new Error("Parent session ended during subagent startup");
  }

  private openCount(): number {
    return [...this.agents.values()].filter((agent) => agent.client || !agent.cleanupDone && agent.status !== "closed").length;
  }

  private ordered(): ManagedAgent[] {
    return [...this.agents.values()].sort((left, right) => Number(isActive(right)) - Number(isActive(left)) || right.startedAt - left.startedAt);
  }

  private captureTranscript(agent: ManagedAgent): void {
    if (!agent.transcript || agent.cleanupDone) return;
    try {
      const entries = agent.transcript();
      if (Array.isArray(entries)) agent.transcriptCache = entries.slice(-500);
    } catch {
      // Keep the last complete transcript snapshot while the child appends or exits.
    }
  }

  private snapshot(agent: ManagedAgent): AgentSnapshot {
    return {
      id: agent.id,
      name: agent.name,
      task: agent.task,
      contextMode: agent.contextMode,
      status: agent.status,
      cwd: agent.cwd,
      model: agent.model,
      thinking: agent.thinking,
      startedAt: agent.startedAt,
      endedAt: agent.endedAt,
      output: boundedText(agent.output, MAX_RESULT_BYTES),
      error: agent.error,
      activity: [...agent.activity],
      usage: { ...agent.usage },
    };
  }

  private changed(): void {
    this.options.hooks?.onChange?.();
  }
}

export function boundedText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = "\n\n[… output truncated …]\n\n";
  const allowance = Math.max(0, maxBytes - Buffer.byteLength(marker));
  let head = text.slice(0, Math.floor(allowance * 0.35));
  let tail = text.slice(-Math.ceil(allowance * 0.65));
  while (Buffer.byteLength(head + marker + tail) > maxBytes && tail) tail = tail.slice(1);
  while (Buffer.byteLength(head + marker + tail) > maxBytes && head) head = head.slice(0, -1);
  return head + marker + tail;
}

export function isActive(agent: Pick<AgentSnapshot, "status">): boolean {
  return agent.status === "starting" || agent.status === "running";
}

function buildChildPrompt(request: SpawnRequest): string {
  const context = request.contextMode === "fresh"
    ? "No parent conversation was inherited. Use the explicit task and project instructions."
    : request.contextMode === "summary"
      ? "A parent-conversation handoff was inherited as context only."
      : "The active parent conversation was inherited as context only.";
  return [
    "You are an isolated delegated subagent.",
    "Complete only the task below and work autonomously with the available tools.",
    "Do not ask the user questions. Report missing information or blockers to the parent.",
    "If editing files, stay within the task's stated write scope and report every changed path.",
    "Return a concise final answer with findings, changes, commands, validation, and remaining risks.",
    context,
    "",
    `Subagent name: ${request.name}`,
    "",
    "Task:",
    request.task,
  ].join("\n");
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") throw new Error("spawn requires a subagent name");
  const name = sanitize(value).replace(/\s+/g, " ").trim();
  if (!name) throw new Error("spawn requires a subagent name");
  if (name.length > MAX_AGENT_NAME_CHARS) throw new Error(`subagent name must be at most ${MAX_AGENT_NAME_CHARS} characters`);
  return name;
}

function normalizeLookup(value: unknown): string {
  const text = sanitize(String(value ?? "")).replace(/\s+/g, " ").trim();
  if (!text) throw new Error("subagent name is required");
  return text;
}

function boundedInput(value: unknown, label: string, maxChars: number): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} requires non-empty text`);
  if (text.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters`);
  return text;
}

function emptyUsage(): AgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function assistantText(message: any): string {
  if (!Array.isArray(message?.content)) return "";
  return sanitize(message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim());
}

function sanitize(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function compact(text: string, limit: number): string {
  const oneLine = sanitize(text).replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

function pushActivity(agent: ManagedAgent, text: string): void {
  agent.activity.push(text);
  if (agent.activity.length > 10) agent.activity.shift();
}

function slug(name: string): string {
  return name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 18) || "agent";
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function unique(agents: ManagedAgent[]): ManagedAgent[] {
  return [...new Map(agents.map((agent) => [agent.id, agent])).values()];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Subagent startup aborted");
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
