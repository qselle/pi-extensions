import { deferredTools } from "../../lib/deferred-tools.ts";
import { resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SchedulePanel } from "./panel.ts";
import { formatDuration } from "../loop/interval.ts";
import {
  MAX_ACTIVE_SCHEDULES,
  MAX_STORED_SCHEDULES,
  completeDelivery,
  createCronTask,
  createReminder,
  parseCronCommand,
  parseReminderCommand,
  pauseTask,
  resumeTask,
  SCHEDULE_STORE_VERSION,
  stopTask,
  type ScheduledTask,
  type ScheduleStore,
} from "./schedule.ts";
import {
  acquireProjectLease,
  loadScheduleStore,
  releaseProjectLease,
  saveScheduleStore,
  scheduleStorePath,
  type ProjectLease,
} from "./store.ts";

const WAKE_TYPE = "schedule-wakeup";
const WAKE_MARKER = "A persistent scheduled task is due.";
const STATUS_KEY = "schedule";
const IDLE_RETRY_MS = 500;
const LEASE_RETRY_MS = 5_000;

interface WakeDetails { taskId: string; wakeKey: string; transient: true }
interface ScheduleExtensionOptions { agentDir?: string; leaseRetryMs?: number; save?: typeof saveScheduleStore }

const StopParameters = Type.Object({
  task_id: Type.Optional(Type.String({ description: "Scheduled task ID. Omit for the task that owns the current turn." })),
  reason: Type.Optional(Type.String({ maxLength: 1_000, description: "Why this scheduled task should stop." })),
});
const ListParameters = Type.Object({});

export default function scheduleExtension(pi: ExtensionAPI, options: ScheduleExtensionOptions = {}): void {
  const controls = deferredTools(pi, ["schedule_stop", "get_schedules"]);
  const panel = new SchedulePanel(pi);
  const tasks = new Map<string, ScheduledTask>();
  const wakePrompts = new Map<string, string>();
  let cwd = resolve(process.cwd());
  let path = "";
  let lease: ProjectLease | undefined;
  let loadError: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingWake: WakeDetails | undefined;
  let runningWake: WakeDetails | undefined;
  let writes = Promise.resolve();
  let management = Promise.resolve();
  let lifecycle = 0;
  let closed = true;

  // Serialize state changes as well as disk writes: a later snapshot must not
  // contain an earlier change that is still capable of rolling back.
  const mutate = <T>(action: () => Promise<T>): Promise<T | undefined> => {
    const generation = lifecycle;
    const operation = management.then(async () => {
      if (generation !== lifecycle || closed) return;
      return action();
    });
    management = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const active = () => [...tasks.values()].filter((task) => task.status === "active");
  const live = () => [...tasks.values()].filter((task) => task.status === "active" || task.status === "paused");
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };

  const store = (): ScheduleStore => ({ version: SCHEDULE_STORE_VERSION, projectCwd: cwd, tasks: [...tasks.values()] });
  const prune = () => {
    if (tasks.size <= MAX_STORED_SCHEDULES) return;
    const terminal = [...tasks.values()].filter((task) => !["active", "paused"].includes(task.status)).sort((a, b) => a.createdAt - b.createdAt);
    while (tasks.size > MAX_STORED_SCHEDULES && terminal.length) tasks.delete(terminal.shift()!.id);
  };
  const persist = async () => {
    if (!lease) throw new Error("This Pi session does not own the project's schedule lease.");
    prune();
    const snapshot = store();
    const destination = path;
    writes = writes.catch(() => undefined).then(() => (options.save ?? saveScheduleStore)(destination, snapshot));
    await writes;
  };

  const updateStatus = (ctx: ExtensionContext) => {
    if (tasks.size) controls.activate();
    const current = active();
    if (loadError) return ctx.ui.setStatus(STATUS_KEY, "schedule error");
    if (current.length === 0) return ctx.ui.setStatus(STATUS_KEY, undefined);
    const next = current.filter((task) => task.nextRunAt !== null).sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0];
    ctx.ui.setStatus(STATUS_KEY, `${current.length} scheduled · ${lease ? (next ? `next ${formatDuration(next.nextRunAt! - Date.now())}` : "waiting") : "read-only"}`);
  };

  const scheduleTimer = (ctx: ExtensionContext) => {
    clearTimer();
    if (closed) { ctx.ui.setStatus(STATUS_KEY, undefined); return; }
    if (loadError || (ctx.mode !== "tui" && ctx.mode !== "rpc") || pendingWake || runningWake) return updateStatus(ctx);
    if (!lease) {
      timer = setTimeout(() => void attemptTakeover(ctx), options.leaseRetryMs ?? LEASE_RETRY_MS);
      return updateStatus(ctx);
    }
    const next = active().filter((task) => task.nextRunAt !== null).sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0];
    if (!next?.nextRunAt) return updateStatus(ctx);
    timer = setTimeout(() => void fireDue(ctx), Math.max(0, Math.min(2_147_483_647, next.nextRunAt - Date.now())));
    updateStatus(ctx);
  };

  const fireDue = (ctx: ExtensionContext) => mutate(async () => {
    const generation = lifecycle;
    timer = undefined;
    if (closed) return;
    if (!lease || !ctx.isIdle() || ctx.hasPendingMessages() || pendingWake || runningWake) {
      timer = setTimeout(() => void fireDue(ctx), IDLE_RETRY_MS); return;
    }
    const task = active().filter((item) => item.nextRunAt !== null && item.nextRunAt <= Date.now()).sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0];
    if (!task) return scheduleTimer(ctx);
    const pending = task.pendingDeliveryAt === undefined ? { ...task, pendingDeliveryAt: task.nextRunAt! } : task;
    tasks.set(task.id, pending);
    try { await persist(); }
    catch (error) {
      if (generation !== lifecycle) return;
      tasks.set(task.id, pauseTask(pending, `Could not persist pending delivery: ${errorMessage(error)}`));
      loadError = errorMessage(error); updateStatus(ctx); ctx.ui.notify(`Schedule ${task.id} paused because durable state could not be written.`, "error"); return;
    }
    if (generation !== lifecycle || closed || !lease) return;
    const wakeKey = `${task.id}:${pending.pendingDeliveryAt}:${Date.now()}`;
    const details = { taskId: task.id, wakeKey, transient: true } satisfies WakeDetails;
    wakePrompts.set(wakeKey, buildWakePrompt(pending)); pendingWake = details;
    try {
      pi.sendMessage({ customType: WAKE_TYPE, content: WAKE_MARKER, display: false, details }, { triggerTurn: true });
    } catch (error) {
      pendingWake = undefined; wakePrompts.delete(wakeKey);
      tasks.set(task.id, pauseTask(pending, `Wakeup failed: ${errorMessage(error)}`));
      await persist().catch(() => undefined);
      if (generation !== lifecycle || closed) return;
      ctx.ui.notify(`Schedule ${task.id} paused because its wakeup failed.`, "error"); scheduleTimer(ctx);
    }
  });

  const attemptTakeover = async (ctx: ExtensionContext) => {
    const generation = lifecycle;
    timer = undefined;
    if (closed) return;
    if (lease || loadError) return scheduleTimer(ctx);
    let acquired: ProjectLease | undefined;
    try {
      acquired = await acquireProjectLease(path);
      if (generation !== lifecycle) { await releaseProjectLease(acquired); return; }
      const loaded = loadScheduleStore(path, cwd);
      tasks.clear();
      for (const task of loaded.tasks) tasks.set(task.id, task);
      lease = acquired;
    } catch (error) {
      await releaseProjectLease(acquired);
      if (generation !== lifecycle || closed) return;
      loadError = errorMessage(error);
      ctx.ui.notify(loadError, "error");
    }
    scheduleTimer(ctx);
  };

  const resolveTask = (query: string, statuses: ScheduledTask["status"][]): ScheduledTask | undefined => {
    const candidates = [...tasks.values()].filter((task) => statuses.includes(task.status));
    if (!query && candidates.length === 1) return candidates[0];
    const exact = candidates.find((task) => task.id === query);
    if (exact) return exact;
    const prefix = candidates.filter((task) => task.id.startsWith(query));
    return prefix.length === 1 ? prefix[0] : undefined;
  };

  const requireWritable = (ctx: ExtensionCommandContext): boolean => {
    if (closed) return false;
    if (loadError) { ctx.ui.notify(loadError, "error"); return false; }
    if (!lease) { ctx.ui.notify("Another Pi process owns this project's schedule queue. This session is read-only.", "warning"); return false; }
    return true;
  };

  const manageNow = async (action: string, query: string, ctx: ExtensionCommandContext) => {
    if (!requireWritable(ctx)) return;
    const generation = lifecycle;
    if (action === "stop" && query === "all") {
      const before = new Map(tasks);
      let count = 0;
      for (const [id, task] of tasks) {
        if (task.status !== "active" && task.status !== "paused") continue;
        tasks.set(id, stopTask(task, "Stopped by the user.")); count++;
      }
      try { await persist(); }
      catch (error) { if (generation !== lifecycle || closed) return; tasks.clear(); for (const [id, task] of before) tasks.set(id, task); ctx.ui.notify(errorMessage(error), "error"); return; }
      if (generation !== lifecycle || closed) return;
      pendingWake = undefined; runningWake = undefined; wakePrompts.clear();
      scheduleTimer(ctx);
      ctx.ui.notify(`Stopped ${count} scheduled task${count === 1 ? "" : "s"}.`, "info"); return;
    }
    const task = resolveTask(query, action === "resume" ? ["paused"] : ["active", "paused"]);
    if (!task) return ctx.ui.notify(`No unambiguous scheduled task matched ${query || "the command"}. Use /schedule status for IDs.`, "warning");
    try {
      const before = task;
      if (action === "pause") tasks.set(task.id, pauseTask(task, "Paused by the user."));
      else if (action === "resume") {
        if (active().length >= MAX_ACTIVE_SCHEDULES) throw new Error(`At most ${MAX_ACTIVE_SCHEDULES} scheduled tasks may be active.`);
        tasks.set(task.id, resumeTask(task));
      } else tasks.set(task.id, stopTask(task, "Stopped by the user."));
      try { await persist(); }
      catch (error) { if (generation !== lifecycle || closed) return; tasks.set(task.id, before); throw error; }
      if (generation !== lifecycle || closed) return;
      if (pendingWake?.taskId === task.id) { wakePrompts.delete(pendingWake.wakeKey); pendingWake = undefined; }
      if (runningWake?.taskId === task.id) { wakePrompts.delete(runningWake.wakeKey); runningWake = undefined; }
      scheduleTimer(ctx); ctx.ui.notify(`Schedule ${task.id} ${action === "stop" ? "stopped" : `${action}d`}.`, "info");
    } catch (error) { if (generation === lifecycle && !closed) ctx.ui.notify(errorMessage(error), "error"); }
  };

  const manage = (action: string, query: string, ctx: ExtensionCommandContext) =>
    mutate(() => manageNow(action, query, ctx));

  pi.registerCommand("remind", {
    description: "Create a persistent one-shot reminder: /remind <duration>|at <ISO time> -- <prompt>",
    handler: (args, ctx) => mutate(async () => {
      if (!requireWritable(ctx)) return;
      const generation = lifecycle;
      if (live().length >= MAX_ACTIVE_SCHEDULES) return ctx.ui.notify(`At most ${MAX_ACTIVE_SCHEDULES} active or paused schedules may be retained.`, "error");
      const parsed = parseReminderCommand(args.trim());
      if (!parsed) return ctx.ui.notify("Usage: /remind [in] <1m-365d> -- <prompt>, or /remind at <ISO-8601 timestamp> -- <prompt>", "warning");
      const task = createReminder(parsed); tasks.set(task.id, task);
      try { await persist(); }
      catch (error) { if (generation !== lifecycle || closed) return; tasks.delete(task.id); ctx.ui.notify(errorMessage(error), "error"); return; }
      if (generation !== lifecycle || closed) return;
      scheduleTimer(ctx); ctx.ui.notify(`Reminder ${task.id} scheduled for ${new Date(task.nextRunAt!).toLocaleString()}.`, "info");
    }),
  });

  pi.registerCommand("cron", {
    description: "Create a persistent five-field cron prompt: /cron <expression> [--tz zone] -- <prompt>",
    handler: (args, ctx) => mutate(async () => {
      if (!requireWritable(ctx)) return;
      const generation = lifecycle;
      if (live().length >= MAX_ACTIVE_SCHEDULES) return ctx.ui.notify(`At most ${MAX_ACTIVE_SCHEDULES} active or paused schedules may be retained.`, "error");
      const parsed = parseCronCommand(args.trim());
      if (!parsed) return ctx.ui.notify("Usage: /cron <minute> <hour> <day> <month> <weekday> [--tz IANA] [--max-runs 1-500] -- <prompt>", "warning");
      try {
        const task = createCronTask(parsed); tasks.set(task.id, task);
        try { await persist(); }
        catch (error) { if (generation !== lifecycle || closed) return; tasks.delete(task.id); throw error; }
        if (generation !== lifecycle || closed) return;
        scheduleTimer(ctx);
        ctx.ui.notify(`Cron ${task.id} scheduled (${task.cronExpression}, ${task.timeZone}); next ${new Date(task.nextRunAt!).toLocaleString()}.`, "info");
      } catch (error) { if (generation === lifecycle && !closed) ctx.ui.notify(errorMessage(error), "error"); }
    }),
  });

  pi.registerCommand("schedule", {
    description: "Inspect or manage persistent reminders and cron prompts",
    getArgumentCompletions: (prefix) => {
      const items = ["status", "view", "pause", "resume", "stop", "stop all"].filter((item) => item.startsWith(prefix.toLowerCase())).map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const input = args.trim();
      if (input === "view") return panel.open(ctx, [...tasks.values()], Boolean(lease), loadError);
      if (!input || input === "status" || input === "list") return ctx.ui.notify(formatScheduleList([...tasks.values()], path, Boolean(lease), loadError), loadError ? "error" : "info");
      const management = /^(pause|resume|stop)(?:\s+(\S+))?$/i.exec(input);
      if (!management) return ctx.ui.notify("Usage: /schedule [status|view|pause <id>|resume <id>|stop <id>|stop all]", "warning");
      await manage(management[1]!.toLowerCase(), management[2] ?? "", ctx);
    },
  });

  pi.registerTool({
    name: "schedule_stop", label: "Stop Schedule", description: "Stop the persistent scheduled task that owns the current turn, or a specified task.", parameters: StopParameters,
    async execute(_id, params) {
      const result = await mutate(async () => {
        if (closed || !lease) throw new Error("This session does not own the schedule queue.");
        const generation = lifecycle;
        const id = params.task_id?.trim() || runningWake?.taskId;
        const task = id ? tasks.get(id) : undefined;
        if (!task || (task.status !== "active" && task.status !== "paused")) throw new Error("No active scheduled task matched the request.");
        tasks.set(task.id, stopTask(task, params.reason?.trim() || "Stopped by the model after handling the scheduled task."));
        try { await persist(); }
        catch (error) { if (generation === lifecycle && !closed) tasks.set(task.id, task); throw error; }
        if (generation !== lifecycle || closed) throw new Error("Session changed while saving the schedule.");
        return { content: [{ type: "text" as const, text: `Schedule ${task.id} stopped.` }], details: { task: tasks.get(task.id) } };
      });
      if (!result) throw new Error("Session changed before saving the schedule.");
      return result;
    },
  });

  pi.registerTool({
    name: "get_schedules", label: "Get Schedules", description: "List persistent project reminders and cron prompts.", parameters: ListParameters,
    async execute() { return { content: [{ type: "text" as const, text: formatScheduleList([...tasks.values()], path, Boolean(lease), loadError) }], details: { tasks: [...tasks.values()], storePath: path, writable: Boolean(lease) } }; },
  });

  pi.on("agent_start", () => { if (pendingWake) { runningWake = pendingWake; pendingWake = undefined; } });
  pi.on("context", (event) => {
    let changed = false;
    const messages = event.messages.flatMap((message) => {
      const candidate = message as { customType?: string; details?: WakeDetails };
      if (candidate.customType !== WAKE_TYPE) return [message];
      changed = true;
      if (!runningWake || candidate.details?.wakeKey !== runningWake.wakeKey) return [];
      return [{ ...message, content: wakePrompts.get(runningWake.wakeKey) ?? WAKE_MARKER } as typeof message];
    });
    return changed ? { messages } : undefined;
  });

  pi.on("message_end", (event, ctx) => mutate(async () => {
    const generation = lifecycle;
    if (generation !== lifecycle || closed || !runningWake || !lease) return;
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
    if (message.role !== "assistant" || (message.stopReason !== "aborted" && message.stopReason !== "error")) return;
    const task = tasks.get(runningWake.taskId);
    if (!task || task.status !== "active") return;
    const reason = message.stopReason === "aborted" ? "The scheduled turn was interrupted by the user." : `Agent run failed: ${message.errorMessage?.trim() || "Unknown provider error"}`;
    tasks.set(task.id, pauseTask(task, reason));
    try {
      await persist();
      if (generation !== lifecycle || closed) return;
      ctx.ui.notify(`Schedule ${task.id} paused; its pending delivery was preserved.`, "warning");
    }
    catch (error) {
      if (generation !== lifecycle || closed) return;
      loadError = errorMessage(error); ctx.ui.notify(`Schedule ${task.id} could not persist its paused state: ${loadError}`, "error");
    }
  }));

  pi.on("agent_settled", (_event, ctx) => mutate(async () => {
    const generation = lifecycle;
    if (generation !== lifecycle || closed) return;
    const wake = runningWake; runningWake = undefined;
    if (wake) wakePrompts.delete(wake.wakeKey);
    if (wake && lease) {
      const task = tasks.get(wake.taskId);
      if (task?.status === "active" && task.pendingDeliveryAt !== undefined) {
        tasks.set(task.id, completeDelivery(task));
        try { await persist(); }
        catch (error) {
          if (generation !== lifecycle || closed) return;
          loadError = errorMessage(error); ctx.ui.notify(`Schedule ${task.id} could not persist delivery completion: ${loadError}`, "error");
        }
      }
    }
    if (generation === lifecycle && !closed) scheduleTimer(ctx);
  }));

  const restore = async (ctx: ExtensionContext) => {
    controls.initialize();
    closed = false;
    const generation = ++lifecycle;
    clearTimer();
    await writes.catch(() => undefined);
    if (generation !== lifecycle) return;
    await releaseProjectLease(lease); lease = undefined; loadError = undefined; writes = Promise.resolve();
    cwd = resolve(ctx.cwd ?? process.cwd()); path = scheduleStorePath(options.agentDir ?? getAgentDir(), cwd);
    tasks.clear(); wakePrompts.clear(); pendingWake = undefined; runningWake = undefined;
    let acquired: ProjectLease | undefined;
    try {
      acquired = await acquireProjectLease(path);
      if (generation !== lifecycle) { await releaseProjectLease(acquired); return; }
      const loaded = loadScheduleStore(path, cwd);
      for (const task of loaded.tasks) tasks.set(task.id, task);
      lease = acquired;
    } catch (error) {
      await releaseProjectLease(acquired);
      if (generation !== lifecycle || closed) return;
      loadError = errorMessage(error); ctx.ui.notify(loadError, "error");
    }
    updateStatus(ctx); scheduleTimer(ctx);
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    closed = true;
    lifecycle++;
    clearTimer(); pendingWake = undefined; runningWake = undefined; wakePrompts.clear();
    const owned = lease; lease = undefined;
    await writes.catch(() => undefined); await releaseProjectLease(owned); ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

function buildWakePrompt(task: ScheduledTask): string {
  const cadence = task.kind === "cron" ? `Cron: ${task.cronExpression} (${task.timeZone}).` : "One-shot reminder.";
  return [
    `Persistent scheduled task ${task.id} is due. ${cadence}`,
    `Task: ${task.prompt}`,
    "Work only within the authority already granted in this conversation and current project. A scheduled wakeup does not authorize destructive actions, external writes, pushes, deployments, purchases, or contacting people.",
    task.kind === "cron" ? "Call schedule_stop if recurrence is no longer useful." : "This reminder completes after the turn settles successfully; interruption or provider failure pauses it with the delivery still pending.",
  ].join("\n\n");
}

function formatScheduleList(tasks: ScheduledTask[], path: string, writable: boolean, error?: string): string {
  const header = error ? `Schedule store error: ${error}` : `Schedule queue: ${writable ? "owner" : "read-only"}\nStore: ${path}`;
  if (!tasks.length) return `${header}\nNo scheduled tasks.`;
  return `${header}\n${tasks.slice().sort((a, b) => b.createdAt - a.createdAt).map((task) => {
    const cadence = task.kind === "cron" ? `${task.cronExpression} (${task.timeZone})` : "one-shot";
    const next = task.nextRunAt === null ? "no wake armed" : `next ${new Date(task.nextRunAt).toISOString()} (${formatDuration(task.nextRunAt - Date.now())})`;
    const reason = task.stopReason ? ` · ${task.stopReason}` : "";
    return `${task.id} [${task.status}] ${task.runs}/${task.maxRuns} · ${cadence} · ${next}${task.pendingDeliveryAt !== undefined ? " · delivery pending" : ""}${reason}\n  ${task.prompt.replace(/\s+/g, " ").slice(0, 180)}`;
  }).join("\n")}`;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
