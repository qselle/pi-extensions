import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadDefaultLoopPrompt } from "./defaults.ts";
import { formatDuration, parseDuration, parseLoopCommand } from "./interval.ts";
import {
  MAX_ACTIVE_LOOPS,
  MAX_CONTEXT_PERCENT,
  MAX_RETAINED_LOOPS,
  beginLoopIteration,
  createLoop,
  decodeLoopSnapshot,
  encodeLoopSnapshot,
  enforceLoopLimits,
  pauseLoop,
  resumeLoop,
  scheduleDynamicFallback,
  scheduleDynamicLoop,
  stopLoop,
  type LoopJob,
} from "./loop.ts";

const ENTRY_TYPE = "loop-state";
const WAKE_MESSAGE_TYPE = "loop-wakeup";
const CONTEXT_MESSAGE_TYPE = "loop-context";
const WAKE_MARKER = "Run the scheduled loop iteration.";
const IDLE_RETRY_MS = 250;

interface LoopWakeDetails {
  loopId: string;
  transient: true;
}

interface LoopToolDetails {
  action: "list" | "schedule" | "stop";
  jobs: LoopJob[];
  message: string;
}

const ScheduleParameters = Type.Object({
  delay_seconds: Type.Integer({
    minimum: 60,
    maximum: 3_600,
    description: "Delay before the next dynamic-loop iteration, from 60 to 3600 seconds.",
  }),
  reason: Type.Optional(Type.String({ maxLength: 1_000, description: "Why this delay fits the observed external state." })),
});
const StopParameters = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 1_000, description: "Why the current loop is complete or should stop." })),
});
const ListParameters = Type.Object({});

export default function loopExtension(pi: ExtensionAPI): void {
  const jobs = new Map<string, LoopJob>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingLoopId: string | undefined;
  let runningLoopId: string | undefined;
  let runningLoopScheduled = false;
  let cwd = process.cwd();
  let projectTrusted = false;
  let closed = true;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const pruneTerminalJobs = () => {
    if (jobs.size <= MAX_RETAINED_LOOPS) return;
    const terminal = [...jobs.values()]
      .filter((job) => job.status === "stopped" || job.status === "expired")
      .sort((a, b) => a.createdAt - b.createdAt);
    while (jobs.size > MAX_RETAINED_LOOPS && terminal.length > 0) {
      jobs.delete(terminal.shift()!.id);
    }
  };

  const persist = () => {
    pruneTerminalJobs();
    pi.appendEntry(ENTRY_TYPE, encodeLoopSnapshot(jobs.values()));
  };

  const activeJobs = () => [...jobs.values()].filter((job) => job.status === "active");
  const liveJobs = () => [...jobs.values()].filter((job) => job.status === "active" || job.status === "paused");

  const updateStatus = (ctx: ExtensionContext) => {
    const active = activeJobs();
    if (active.length === 0) {
      ctx.ui.setStatus("loop", undefined);
      return;
    }
    const next = active
      .filter((job) => job.nextRunAt !== null)
      .sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0];
    const suffix = next?.nextRunAt === null || next === undefined
      ? "running"
      : `next ${formatDuration(next.nextRunAt - Date.now())}`;
    ctx.ui.setStatus("loop", `${active.length} loop${active.length === 1 ? "" : "s"} · ${suffix}`);
  };

  const save = (ctx: ExtensionContext) => {
    persist();
    updateStatus(ctx);
  };

  const enforceLimits = (ctx: ExtensionContext) => {
    let changed = false;
    const now = Date.now();
    for (const [id, current] of jobs) {
      const limited = enforceLoopLimits(current, now);
      if (limited !== current) {
        jobs.set(id, limited);
        changed = true;
      }
    }
    if (changed) save(ctx);
  };

  const scheduleTimer = (ctx: ExtensionContext) => {
    clearTimer();
    if (closed) { ctx.ui.setStatus("loop", undefined); return; }
    enforceLimits(ctx);
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
      updateStatus(ctx);
      return;
    }
    if (pendingLoopId || runningLoopId) {
      updateStatus(ctx);
      return;
    }

    const next = activeJobs()
      .filter((job) => job.nextRunAt !== null)
      .sort(
        (a, b) => Math.min(a.nextRunAt!, a.expiresAt) - Math.min(b.nextRunAt!, b.expiresAt),
      )[0];
    if (!next || next.nextRunAt === null) {
      updateStatus(ctx);
      return;
    }

    const target = Math.min(next.nextRunAt, next.expiresAt);
    const delay = Math.max(0, Math.min(2_147_483_647, target - Date.now()));
    timer = setTimeout(() => fireDueLoop(ctx), delay);
    updateStatus(ctx);
  };

  const fireDueLoop = (ctx: ExtensionContext) => {
    timer = undefined;
    if (closed) return;
    enforceLimits(ctx);
    if (!ctx.isIdle() || ctx.hasPendingMessages() || pendingLoopId || runningLoopId) {
      timer = setTimeout(() => fireDueLoop(ctx), IDLE_RETRY_MS);
      return;
    }

    const due = activeJobs()
      .filter((job) => job.nextRunAt !== null && job.nextRunAt <= Date.now())
      .sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0];
    if (!due) {
      scheduleTimer(ctx);
      return;
    }

    const contextUsage = ctx.getContextUsage?.();
    if (contextUsage?.percent !== null && contextUsage?.percent !== undefined && contextUsage.percent >= MAX_CONTEXT_PERCENT) {
      jobs.set(due.id, pauseLoop(due, `Context usage reached ${Math.round(contextUsage.percent)}%.`));
      save(ctx);
      ctx.ui.notify(`Loop ${due.id} paused at the context-usage limit.`, "warning");
      scheduleTimer(ctx);
      return;
    }

    pendingLoopId = due.id;
    try {
      pi.sendMessage(
        {
          customType: WAKE_MESSAGE_TYPE,
          content: WAKE_MARKER,
          display: false,
          details: { loopId: due.id, transient: true } satisfies LoopWakeDetails,
        },
        { triggerTurn: true },
      );
    } catch (error) {
      pendingLoopId = undefined;
      jobs.set(due.id, pauseLoop(due, `Wakeup failed: ${errorMessage(error)}`));
      save(ctx);
      ctx.ui.notify(`Loop ${due.id} paused because its wakeup failed.`, "error");
      scheduleTimer(ctx);
    }
  };

  const resolveJob = (query: string, statuses?: LoopJob["status"][]): LoopJob | undefined => {
    const candidates = [...jobs.values()].filter((job) => !statuses || statuses.includes(job.status));
    if (!query && candidates.length === 1) return candidates[0];
    const exact = candidates.find((job) => job.id === query);
    if (exact) return exact;
    const prefix = candidates.filter((job) => job.id.startsWith(query));
    return prefix.length === 1 ? prefix[0] : undefined;
  };

  const manageLoop = (action: string, query: string, ctx: ExtensionCommandContext) => {
    if (action === "stop" && query === "all") {
      let count = 0;
      for (const [id, job] of jobs) {
        if (job.status !== "active" && job.status !== "paused") continue;
        jobs.set(id, stopLoop(job, "stopped", "Stopped by the user."));
        count++;
      }
      pendingLoopId = undefined;
      save(ctx);
      scheduleTimer(ctx);
      ctx.ui.notify(`Stopped ${count} loop${count === 1 ? "" : "s"}.`, "info");
      return;
    }

    const statuses = action === "resume" ? ["paused"] as const : ["active", "paused"] as const;
    const job = resolveJob(query, [...statuses]);
    if (!job) {
      ctx.ui.notify(`No unambiguous loop matched ${query || "the command"}. Use /loop status for IDs.`, "warning");
      return;
    }

    try {
      if (action === "pause") jobs.set(job.id, pauseLoop(job, "Paused by the user."));
      else if (action === "resume") {
        if (activeJobs().length >= MAX_ACTIVE_LOOPS) {
          throw new Error(`At most ${MAX_ACTIVE_LOOPS} loops may be active at once.`);
        }
        jobs.set(job.id, resumeLoop(job));
      }
      else jobs.set(job.id, stopLoop(job, "stopped", "Stopped by the user."));
      if (pendingLoopId === job.id) pendingLoopId = undefined;
      save(ctx);
      scheduleTimer(ctx);
      ctx.ui.notify(`Loop ${job.id} ${action === "stop" ? "stopped" : `${action}d`}.`, "info");
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  };

  pi.registerCommand("loop", {
    description: "Run a prompt on a fixed or model-chosen cadence: /loop [<interval>] <prompt>",
    getArgumentCompletions: (prefix) => {
      const actions = ["status", "pause", "resume", "stop", "stop all"];
      const items = actions
        .filter((action) => action.startsWith(prefix.toLowerCase()))
        .map((action) => ({ value: action, label: action }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const input = args.trim();
      if (input === "status" || input === "list") {
        ctx.ui.notify(formatLoopList([...jobs.values()]), "info");
        return;
      }

      const management = /^(pause|resume|stop)(?:\s+(\S+))?$/i.exec(input);
      if (management) {
        manageLoop(management[1]!.toLowerCase(), management[2] ?? "", ctx);
        return;
      }

      if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
        ctx.ui.notify("Loops require a persistent TUI or RPC session.", "error");
        return;
      }
      if (liveJobs().length >= MAX_ACTIVE_LOOPS) {
        ctx.ui.notify(`At most ${MAX_ACTIVE_LOOPS} active or paused loops may be retained at once.`, "error");
        return;
      }

      const defaultPrompt = !input || parseDuration(input) !== undefined
        ? loadDefaultLoopPrompt(cwd, undefined, projectTrusted)
        : undefined;
      const intervalOnly = input ? parseDuration(input) : undefined;
      const parsed = defaultPrompt
        ? { prompt: defaultPrompt.prompt, intervalMs: intervalOnly ?? null }
        : parseLoopCommand(input);
      if (!parsed) {
        ctx.ui.notify("Usage: /loop [5m] [<prompt>], or /loop <prompt> every 5m", "warning");
        return;
      }
      try {
        const job = createLoop(
          parsed.prompt,
          parsed.intervalMs,
          Date.now(),
          undefined,
          defaultPrompt ? "default" : "explicit",
        );
        jobs.set(job.id, job);
        save(ctx);
        scheduleTimer(ctx);
        const cadence = job.mode === "dynamic" ? "model-paced" : `every ${formatDuration(job.intervalMs!)}`;
        const source = defaultPrompt ? `, ${defaultPrompt.source} maintenance prompt` : "";
        ctx.ui.notify(`Loop ${job.id} started (${cadence}${source}, max ${job.maxIterations} iterations / 12h).`, "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "loop_schedule",
    label: "Schedule Loop",
    description: "Schedule the next iteration of the dynamic /loop that owns the current turn. Call this once near the end of every dynamic-loop iteration unless the loop is complete; use loop_stop when it is complete. The delay is clamped to 60 seconds through 1 hour.",
    parameters: ScheduleParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const job = runningLoopId ? jobs.get(runningLoopId) : undefined;
      if (!job) throw new Error("No scheduled loop owns the current turn.");
      if (job.mode !== "dynamic") throw new Error("Fixed loops keep their configured cadence and cannot be rescheduled by the model.");
      const scheduled = scheduleDynamicLoop(job, params.delay_seconds * 1_000, params.reason);
      jobs.set(job.id, scheduled);
      runningLoopScheduled = true;
      save(ctx);
      const reason = scheduled.lastScheduleReason ? ` Reason: ${scheduled.lastScheduleReason}` : "";
      return toolResult("schedule", jobs, `Loop ${job.id} will wake in ${formatDuration(scheduled.nextRunAt! - Date.now())}.${reason}`);
    },
  });

  pi.registerTool({
    name: "loop_stop",
    label: "Stop Loop",
    description: "Stop the /loop that owns the current turn because its task is complete or recurring work is no longer useful. This only affects a loop-created turn.",
    parameters: StopParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const job = runningLoopId ? jobs.get(runningLoopId) : undefined;
      if (!job) throw new Error("No scheduled loop owns the current turn.");
      jobs.set(job.id, stopLoop(job, "stopped", params.reason?.trim() || "Stopped by the model after completing the loop task."));
      runningLoopScheduled = true;
      save(ctx);
      return toolResult("stop", jobs, `Loop ${job.id} stopped.`);
    },
  });

  pi.registerTool({
    name: "get_loops",
    label: "Get Loops",
    description: "List the session's scheduled loops, including cadence, status, iteration count, and next wakeup.",
    parameters: ListParameters,
    async execute() {
      return toolResult("list", jobs, formatLoopList([...jobs.values()]));
    },
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!pendingLoopId) return;
    const job = jobs.get(pendingLoopId);
    runningLoopId = pendingLoopId;
    pendingLoopId = undefined;
    runningLoopScheduled = false;
    if (!job || job.status !== "active") {
      runningLoopId = undefined;
      return;
    }
    jobs.set(job.id, beginLoopIteration(job));
    save(ctx);
  });

  pi.on("context", (event) => {
    const ownerId = runningLoopId ?? pendingLoopId;
    const owner = ownerId ? jobs.get(ownerId) : undefined;
    const messages = event.messages as Array<{ customType?: string; details?: unknown; content?: unknown }>;
    let latestWake = -1;
    if (owner) {
      for (let index = 0; index < messages.length; index++) {
        if (isWakeFor(messages[index], owner.id)) latestWake = index;
      }
    }
    let changed = false;
    const transformed = event.messages.flatMap((message, index) => {
      const customType = (message as { customType?: string }).customType;
      if (customType !== WAKE_MESSAGE_TYPE && customType !== CONTEXT_MESSAGE_TYPE) return [message];
      changed = true;
      if (!owner || index !== latestWake) return [];
      return [{
        ...message,
        customType: CONTEXT_MESSAGE_TYPE,
        content: buildLoopPrompt(
          owner,
          owner.promptSource === "default" ? loadDefaultLoopPrompt(cwd, undefined, projectTrusted).prompt : owner.prompt,
        ),
        details: { loopId: owner.id, transient: true },
      } as typeof message];
    });
    return changed ? { messages: transformed } : undefined;
  });

  pi.on("message_end", (event, ctx) => {
    if (closed) return;
    const id = runningLoopId;
    if (!id) return;
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
    if (message.role !== "assistant") return;
    const job = jobs.get(id);
    if (!job || job.status !== "active") return;

    if (message.stopReason === "aborted") {
      jobs.set(id, pauseLoop(job, "The loop iteration was interrupted by the user."));
      save(ctx);
      ctx.ui.notify(`Loop ${id} paused because its iteration was interrupted.`, "warning");
    } else if (message.stopReason === "error") {
      const detail = message.errorMessage?.trim() || "Unknown provider error";
      jobs.set(id, pauseLoop(job, `Agent run failed: ${detail}`));
      save(ctx);
      ctx.ui.notify(`Loop ${id} paused after an agent error.`, "warning");
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (closed) return;
    const id = runningLoopId;
    runningLoopId = undefined;
    if (id) {
      const job = jobs.get(id);
      if (job?.status === "active" && job.mode === "dynamic" && job.nextRunAt === null) {
        if (!runningLoopScheduled && job.fallbackWakeups === 0) {
          jobs.set(id, scheduleDynamicFallback(job));
          ctx.ui.notify(`Loop ${id} did not schedule itself; one 20m fallback wakeup was armed.`, "warning");
        } else {
          jobs.set(id, stopLoop(job, "stopped", "The dynamic loop failed to schedule two consecutive iterations."));
          ctx.ui.notify(`Loop ${id} stopped after a second missing schedule.`, "warning");
        }
        save(ctx);
      }
    }
    runningLoopScheduled = false;
    scheduleTimer(ctx);
  });

  const restore = (ctx: ExtensionContext) => {
    closed = false;
    cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
    projectTrusted = ctx.isProjectTrusted?.() ?? false;
    clearTimer();
    jobs.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const snapshot = decodeLoopSnapshot(entry.data);
      if (!snapshot) continue;
      jobs.clear();
      for (const restored of snapshot.jobs) {
        let job = enforceLoopLimits(restored);
        if (job.status === "active" && job.nextRunAt === null) {
          job = job.mode === "dynamic"
            ? scheduleDynamicFallback(job)
            : { ...job, nextRunAt: Date.now() };
        }
        jobs.set(job.id, job);
      }
    }
    pendingLoopId = undefined;
    runningLoopId = undefined;
    runningLoopScheduled = false;
    updateStatus(ctx);
    scheduleTimer(ctx);
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    closed = true;
    clearTimer();
    pendingLoopId = undefined;
    runningLoopId = undefined;
    runningLoopScheduled = false;
    persist();
    ctx.ui.setStatus("loop", undefined);
  });
}

function buildLoopPrompt(job: LoopJob, prompt: string): string {
  const cadence = job.mode === "fixed"
    ? `This loop runs every ${formatDuration(job.intervalMs!)}.`
    : "This loop is model-paced. Before finishing, call loop_schedule with a 60-3600 second delay, or call loop_stop if the task is complete.";
  return [
    `Scheduled loop iteration ${job.iterations}/${job.maxIterations}.`,
    `Task: ${prompt}`,
    cadence,
    "Inspect current state and do useful work; do not busy-wait. A loop wakeup does not grant new authority for destructive or external actions.",
    job.mode === "fixed" ? "Call loop_stop when recurring work is complete or no longer useful." : "",
  ].filter(Boolean).join("\n\n");
}

function formatLoopList(jobs: LoopJob[]): string {
  if (jobs.length === 0) return "No loops are scheduled.";
  return jobs
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((job) => {
      const cadence = job.mode === "dynamic" ? "dynamic" : `every ${formatDuration(job.intervalMs!)}`;
      const next = job.nextRunAt === null ? "no wake armed" : `next ${formatDuration(job.nextRunAt - Date.now())}`;
      const reason = job.stopReason ? ` · ${job.stopReason}` : "";
      const pacing = job.lastScheduleReason ? ` · pacing: ${job.lastScheduleReason.replace(/\s+/g, " ").slice(0, 120)}` : "";
      return `${job.id} [${job.status}] ${job.iterations}/${job.maxIterations} · ${cadence} · ${next}${pacing}${reason}\n  ${job.prompt.replace(/\s+/g, " ").slice(0, 160)}`;
    })
    .join("\n");
}

function toolResult(action: LoopToolDetails["action"], jobs: Map<string, LoopJob>, message: string) {
  const details: LoopToolDetails = { action, jobs: [...jobs.values()], message };
  return { content: [{ type: "text" as const, text: message }], details };
}

function isWakeFor(message: unknown, loopId: string): boolean {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { customType?: string; details?: { loopId?: string } };
  return candidate.customType === WAKE_MESSAGE_TYPE && candidate.details?.loopId === loopId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
