import { getShellConfig, type ExtensionAPI, type ExtensionContext, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerOverlayCard, type OverlayCardHandle } from "../overlay-stack/index.ts";
import { TranscriptView } from "../../lib/transcript/view.ts";
import { elapsed } from "../working-status/state.ts";
import { JobService, isActive, MAX_RETAINED_JOBS, MAX_WAIT_MS, type JobSnapshot } from "./service.ts";
import { knownSecretValues } from "../questions/secrets.ts";
import { outputWindow, PlainOutput } from "../../lib/output.ts";
import { redactText } from "../../lib/redact.ts";
import { BASH_OWNER, BASH_STYLE, type BashOwnerRequest, type BashStyleRequest, type BashStyle } from "./bash-style.ts";
import { JOB_HISTORY_ENTRY, JobHistory } from "./history.ts";
import { deferredTools } from "../../lib/deferred-tools.ts";
import { commandPurposeParameter, COMMAND_PURPOSE_GUIDELINE, toolPurpose, toolPurposeParameter } from "../../lib/tool-purpose.ts";
import { argumentAliases, DEFAULT_OUTPUT_CHARS, DEFAULT_YIELD_MS, MAX_OUTPUT_CHARS, MAX_YIELD_MS, outputBudget, START_YIELD_MS, waitDuration, yieldDuration } from "./arguments.ts";
import { headline, lines, renderJobList, renderJobResult } from "./render.ts";
const JOB_CONTROLS = ["job_output", "job_wait", "job_list", "job_write", "job_resize", "job_stop"];
/** Pi's built-in bash guideline, kept when the managed executor replaces bash. */
export const PI_ENV_GUIDELINE = "You can inspect PI_* environment variables for current model and session details.";
export const FOREGROUND_GUIDELINE = "Keep commands in the foreground: bash yields a job ID after yield_ms, so do not background them with &, nohup, disown, or setsid.";
export const YIELD_GUIDELINE = "A yielded bash job is still running. Use job_wait to check its exit status before treating the command as successful.";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

const icons: Record<JobSnapshot["status"], string> = { starting: "◌", running: "●", stopping: "◌", completed: "✓", failed: "×", stopped: "■", "timed-out": "◷", interrupted: "?" };
const exitSummary = (job: JobSnapshot) => job.signal ? ` · ${job.signal}` : job.code != null ? ` · exit ${job.code}` : "";
const brief = (job: JobSnapshot) => `${icons[job.status]} ${job.name} · ${job.status} · ${job.status === "interrupted" ? "completion unknown" : elapsed((job.endedAt ?? Date.now()) - job.startedAt)}${exitSummary(job)}`;
const safeLabel = (text: unknown) => redactText(new PlainOutput().push(typeof text === "string" ? text : "").replace(/\s+/g, " "), knownSecretValues());
// Redact before the display cap so a secret crossing that cap stays hidden.
const safePurpose = (value: unknown, targets: readonly unknown[] = []) => toolPurpose(
  safeLabel(typeof value === "string" ? value.replace(/\p{Bidi_Control}/gu, "") : ""), targets.map(safeLabel),
);

const cap = (text: string, maximum: number) => {
  const characters = Array.from(text);
  return characters.length > maximum ? characters.slice(0, maximum - 1).join("").trimEnd() + "…" : text;
};
/** Default job label: the caller's purpose, else the start of the command. Redacted before capping. */
export const jobName = (purpose: unknown, command: unknown) => cap(safePurpose(purpose), 80) || cap(safeLabel(command).trim(), 60) || "Shell command";

function jobHeading(title: string, args: Record<string, unknown>, theme: Theme, context?: ToolRenderContext) {
  return headline(title, safePurpose(args.purpose, [args.id, args.name, args.command]), theme, context);
}

interface ReadRequest {
  /** Explicit cursor pages forward; omitted reads the newest output since the last agent read. */
  cursor?: number;
  budget?: number;
  /** Advance the per-job agent cursor. UI-only reads leave it untouched. */
  track?: boolean;
  hint?: boolean;
}

export default function backgroundJobsExtension(pi: ExtensionAPI): void {
  const controls = deferredTools(pi, ["job_start", ...JOB_CONTROLS]);
  let service = new JobService(3000, knownSecretValues);
  let card: OverlayCardHandle | undefined;
  let viewer: TranscriptView | undefined;
  let viewerOpen = false;
  let generation = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  const history = new JobHistory();
  const completionViews = new Map<string, Set<() => void>>();
  let historyReady = false;
  let closing = false;
  let historyError: string | undefined;
  const allJobs = () => {
    const jobs = new Map(history.list().map((job) => [job.id, job]));
    for (const job of service.list()) jobs.set(job.id, job);
    const active = [...jobs.values()].filter((job) => isActive(job.status));
    const ended = [...jobs.values()].filter((job) => !isActive(job.status)).sort((a, b) => a.startedAt - b.startedAt);
    return [...active, ...ended.slice(-Math.max(0, MAX_RETAINED_JOBS - active.length))];
  };
  const findJob = (id: string) => {
    const job = service.list().find((job) => job.id === id) ?? history.get(id);
    if (!job) throw new Error("Unknown job ID.");
    return job;
  };
  const clearRefresh = () => { if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = undefined; };
  const redraw = () => { clearRefresh(); card?.invalidate(); viewer?.refresh(); };
  const listen = () => {
    unsubscribe?.();
    unsubscribe = service.subscribe((job, output) => {
      if (!output && historyReady) {
        const record = history.observe(job);
        if (record) {
          try { pi.appendEntry(JOB_HISTORY_ENTRY, record); }
          catch { historyError = "Job history could not be saved. Current jobs remain managed; reload may lose their completion records."; }
        }
        if (!isActive(job.status)) {
          for (const invalidate of completionViews.get(job.id) ?? []) { try { invalidate(); } catch {} }
          completionViews.delete(job.id);
        }
      }
      if (closing) return;
      if (!output) redraw();
      else if (viewer && !refreshTimer) { refreshTimer = setTimeout(redraw, 100); refreshTimer.unref?.(); }
    });
  };
  listen();

  // Server-side read position per job, so an omitted cursor never repeats output the agent has seen.
  const agentCursors = new Map<string, number>();
  const result = (id: string, request: ReadRequest = {}, source = service) => {
    const live = source.list().find((job) => job.id === id);
    const job = live ?? findJob(id);
    const newest = request.cursor === undefined;
    const from = request.cursor ?? agentCursors.get(id) ?? 0;
    const budget = request.budget ?? DEFAULT_OUTPUT_CHARS;
    const output = live ? source.window(id, from, budget, newest) : outputWindow(job.tail, job.outputEnd - job.tail.length, from, budget, newest);
    if (request.track !== false) agentCursors.set(id, Math.max(agentCursors.get(id) ?? 0, output.cursor));
    const header = [brief(job), `Job: ${id} · cursor: ${output.cursor}${output.more ? " · more output available" : ""}`];
    if (output.lost) header.push(`${output.lost} older characters were evicted from the bounded log.`);
    if (job.error) header.push(job.error);
    if (!live) header.push("Historical record: only the saved output tail is available; no process was resumed.");
    if (live && isActive(job.status) && request.hint !== false) header.push(`Still running — job_wait id=${id} waits for the exit status; job_stop id=${id} stops it.`);
    const marker = output.omitted ? `[earlier output omitted (${output.omitted} chars); use cursor ${output.from} to read from the start]\n` : "";
    const text = `${header.join("\n")}\n\n${marker}${output.text || (marker ? "" : "No new output.")}`;
    const durationMs = job.status === "interrupted" ? undefined : (job.endedAt ?? Date.now()) - job.startedAt;
    return { content: [{ type: "text" as const, text }], details: {
      managed: true, id, name: job.name, status: job.status, exitCode: job.code, signal: job.signal,
      startedAt: job.startedAt, endedAt: job.endedAt, durationMs,
      cursor: output.cursor, more: output.more, lost: output.lost, omitted: output.omitted,
    } };
  };
  const renderResult = (value: any, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context?: ToolRenderContext) => renderJobResult(value, options, theme, context);
  const renderStartResult = (value: any, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context?: ToolRenderContext, renderer = renderResult) => {
    const id = value.details?.id;
    const observedStatus = value.details?.status;
    if (!options.isPartial && typeof id === "string" && isActive(observedStatus)) {
      const current = service.list().find((job) => job.id === id) ?? history.get(id);
      if (current && !isActive(current.status)) {
        return renderer({ ...value, details: { ...value.details, status: current.status }, content: [{ type: "text", text:
          `${brief(current)}\nJob: ${id} · ${current.status === "interrupted" ? "no completion record" : "final output tail"}${current.error ? `\n${current.error}` : ""}\n\n${current.tail || "No output."}`,
        }] }, options, theme, context);
      }
      if (current && context && context.state.completionJob !== id) {
        const views = completionViews.get(id) ?? new Set<() => void>();
        views.add(context.invalidate);
        completionViews.set(id, views);
        context.state.completionJob = id;
      }
    }
    return renderer(value, options, theme, context);
  };

  interface StartParams {
    command: string; name: string; pty?: boolean; columns?: number; rows?: number; stdin?: boolean;
    yield_ms: number; timeout_seconds?: number; max_chars?: number;
  }
  const startManaged = async (params: StartParams, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: (result: any) => void) => {
      const shell = getShellConfig();
      const env = { ...process.env };
      for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
      env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
      const file = ctx.sessionManager.getSessionFile();
      if (file) env.PI_SESSION_FILE = file;
      if (ctx.model) { env.PI_PROVIDER = ctx.model.provider; env.PI_MODEL = ctx.model.id; }
      env.PI_REASONING_LEVEL = pi.getThinkingLevel();
      const jobs = service;
      const job = jobs.start({ pty: params.pty, columns: params.columns, rows: params.rows, stdin: params.stdin, command: params.command, name: params.name, cwd: ctx.cwd, executable: shell.shell, args: [...shell.args, params.command], env, timeoutMs: params.timeout_seconds === undefined ? undefined : params.timeout_seconds * 1000 }, signal);
      let refresh: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const publish = () => {
        if (stopped || signal?.aborted || !onUpdate) return;
        const snapshot = jobs.get(job.id);
        const value = result(job.id, { cursor: Math.max(0, snapshot.outputEnd - 8192), track: false, hint: false }, jobs);
        const seconds = Math.floor((Date.now() - snapshot.startedAt) / 1000);
        value.content[0]!.text = `${seconds}s elapsed · ${value.content[0]!.text}`;
        try { onUpdate(value); } catch { /* Rendering failure must not orphan a command. */ }
      };
      const unsubscribe = onUpdate ? jobs.subscribe((snapshot) => {
        if (snapshot.id !== job.id || refresh || stopped) return;
        refresh = setTimeout(() => { refresh = undefined; publish(); }, 100);
        refresh.unref?.();
      }) : undefined;
      const ticker = onUpdate ? setInterval(publish, 1000) : undefined;
      ticker?.unref?.();
      publish();
      try { await jobs.wait(job.id, params.yield_ms, signal); }
      catch (error) { jobs.stop(job.id); throw error; }
      finally { stopped = true; unsubscribe?.(); if (refresh) clearTimeout(refresh); if (ticker) clearInterval(ticker); }
      if (isActive(jobs.get(job.id).status)) controls.activate(JOB_CONTROLS);
      return result(job.id, { budget: outputBudget(params.max_chars) }, jobs);
  };

  const budgetParameter = Type.Optional(Type.Integer({ minimum: 1, description: `Output budget in characters; the newest output is kept (default ${DEFAULT_OUTPUT_CHARS}, capped at ${MAX_OUTPUT_CHARS}).` }));
  const stdinParameter = Type.Optional(Type.Boolean({ description: "Keep stdin open for job_write. Pipe jobs otherwise start with stdin at EOF; PTYs always accept input." }));
  let bashStyle: BashStyle | undefined;
  const bashParameters = Type.Object({ purpose: commandPurposeParameter, command: Type.String({ minLength: 1, maxLength: 16000 }), timeout: Type.Optional(Type.Number({ minimum: 0.1, maximum: 86400 })),
    yield_ms: Type.Optional(Type.Integer({ minimum: 0, description: `Milliseconds to wait before returning a job ID (default ${DEFAULT_YIELD_MS}, capped at ${MAX_YIELD_MS}).` })),
    max_chars: budgetParameter, stdin: stdinParameter, pty: Type.Optional(Type.Boolean()), columns: Type.Optional(Type.Integer({ minimum: 10, maximum: 500 })), rows: Type.Optional(Type.Integer({ minimum: 2, maximum: 200 })), name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })) });
  const bashDefinition = (): ToolDefinition<any> => ({
    name: "bash", label: "bash",
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    description: `Execute a managed shell command in the current working directory. Short commands finish inline; after yield_ms (default ${DEFAULT_YIELD_MS}) a running command returns a job ID. Use job_wait/job_output, job_write, job_resize and job_stop to control it. Results show the newest max_chars characters. Optional timeout is in seconds. stdin is at EOF unless stdin=true. Use pty for interactive terminal programs (Node.js required). Keep commands in the foreground; do not use &, nohup, disown, or setsid.`,
    promptSnippet: "Execute shell commands; long commands yield managed job IDs for follow-up.",
    promptGuidelines: [PI_ENV_GUIDELINE, FOREGROUND_GUIDELINE, YIELD_GUIDELINE, COMMAND_PURPOSE_GUIDELINE],
    parameters: bashParameters,
    prepareArguments: argumentAliases(bashParameters),
    async execute(_id, params: any, signal, update, ctx) {
      const { purpose, ...execution } = params;
      const value = await startManaged({ ...execution, name: execution.name ?? jobName(purpose, execution.command), timeout_seconds: execution.timeout, yield_ms: yieldDuration(execution.yield_ms) }, signal, ctx, update);
      // Keep details for renderers; the model still receives an error result.
      return ["failed", "timed-out", "stopped"].includes(value.details.status) ? { ...value, isError: true } : value;
    },
    renderShell: bashStyle?.renderShell,
    renderCall: (args: any, theme, context) => {
      const purpose = safePurpose(args.purpose, [args.command]);
      const shown = { ...args, purpose, command: new PlainOutput().push(redactText(String(args.command ?? ""), knownSecretValues())) };
      return bashStyle?.renderCall?.(shown, theme, context)
        ?? lines([...(purpose ? [theme.fg("muted", purpose)] : []), theme.fg("accent", `$ ${safeLabel(args.command)}`)].join("\n"));
    },
    renderResult: (value, options, theme, context) => renderStartResult(value, options, theme, context,
      bashStyle?.renderResult ? (resolved, opts, selectedTheme, selectedContext) => bashStyle!.renderResult!(resolved, opts, selectedTheme, selectedContext!) : renderResult),
  });
  const registerBash = () => { const definition = bashDefinition(); pi.registerTool(definition); return definition; };
  const unsubscribeOwner = pi.events.on(BASH_OWNER, (data) => {
    const request = data as BashOwnerRequest;
    if (typeof request?.claim !== "function") return;
    if (request.style) bashStyle = request.style;
    request.claim(registerBash());
  });
  pi.events.emit(BASH_STYLE, { provide: (style, install) => { bashStyle = style; install(bashDefinition()); } } satisfies BashStyleRequest);
  registerBash();

  const startParameters = Type.Object({ purpose: toolPurposeParameter, pty: Type.Optional(Type.Boolean()), columns: Type.Optional(Type.Integer({ minimum: 10, maximum: 500 })), rows: Type.Optional(Type.Integer({ minimum: 2, maximum: 200 })), command: Type.String({ minLength: 1, maxLength: 16000 }), name: Type.String({ minLength: 1, maxLength: 80 }),
    yield_ms: Type.Optional(Type.Integer({ minimum: 0, description: `Milliseconds to wait before returning a job ID (default ${START_YIELD_MS}, capped at ${MAX_YIELD_MS}).` })),
    timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400 })), max_chars: budgetParameter, stdin: stdinParameter });
  pi.registerTool({
    name: "job_start", label: "Start background job",
    description: "Start a managed shell command. It may finish during yield_ms or keep running with a job ID. Use job_wait/job_output to read output, job_write for input (pipe jobs need stdin=true), and job_stop for cleanup. Run the command in the foreground; do not use &, nohup, disown, or setsid. Set pty=true for interactive terminal programs (Node.js required); otherwise uses pipes. PTY output is a sanitized text log, not a screen emulator.",
    promptSnippet: "Run long-lived commands as managed background jobs with bounded logs and explicit cleanup.",
    parameters: startParameters,
    prepareArguments: argumentAliases(startParameters),
    renderShell: "self",
    async execute(_id, params, signal, update, ctx) {
      const { purpose: _purpose, ...execution } = params;
      return startManaged({ ...execution, yield_ms: yieldDuration(execution.yield_ms, START_YIELD_MS) }, signal, ctx, update);
    },
    renderCall: (args, theme, context) => jobHeading(`Start job · ${safeLabel(args.name) || "command"}`, args, theme, context), renderResult: renderStartResult,
  });
  const readParameters = Type.Object({ purpose: toolPurposeParameter, id: Type.String(),
    cursor: Type.Optional(Type.Integer({ minimum: 0, description: "Absolute offset to page forward from. Omit to get the newest output since your last read of this job." })),
    wait_ms: Type.Optional(Type.Integer({ minimum: 0, description: `Milliseconds to wait for the job to exit, capped at ${MAX_WAIT_MS}.` })),
    max_chars: budgetParameter });
  for (const name of ["job_output", "job_wait"] as const) pi.registerTool({
    name, label: name === "job_wait" ? "Wait for job" : "Read job output",
    description: name === "job_wait"
      ? `Wait for a managed job to exit, up to wait_ms (default and cap ${MAX_WAIT_MS}), then return its status and output since your last read. Cancelling a wait leaves the job running.`
      : "Read managed job output without waiting (wait_ms optional). Omit cursor to get the newest output since your last read; pass a cursor to page forward from an absolute offset.",
    parameters: readParameters,
    prepareArguments: argumentAliases(readParameters),
    renderShell: "self",
    async execute(_id, params, signal) {
      const jobs = service;
      if (jobs.list().some((job) => job.id === params.id)) await jobs.wait(params.id, waitDuration(params.wait_ms, name === "job_wait" ? MAX_WAIT_MS : 0), signal);
      else signal?.throwIfAborted();
      return result(params.id, { cursor: params.cursor, budget: outputBudget(params.max_chars) }, jobs);
    },
    renderCall: (args, theme, context) => jobHeading(`${name === "job_wait" ? "Wait for" : "Read"} job · ${safeLabel(args.id)}`, args, theme, context), renderResult,
  });
  const listParameters = Type.Object({ purpose: toolPurposeParameter });
  pi.registerTool({
    name: "job_list", label: "List background jobs", description: "List this session's managed jobs and their IDs, including recent finished jobs. Use job_output for logs.",
    parameters: listParameters,
    prepareArguments: argumentAliases(listParameters),
    renderShell: "self",
    async execute() {
      const jobs = allJobs();
      return { content: [{ type: "text", text: jobs.map((job) => `${job.id} · ${brief(job)}\n${job.command.slice(0, 180)}`).join("\n\n") || "No managed jobs in this session." }],
        details: { jobs: jobs.map(({ id, name, status, code, signal, startedAt, endedAt }) => ({ id, name, status, icon: icons[status], exitCode: code, signal, startedAt, endedAt })) } };
    },
    renderCall: (args, theme, context) => jobHeading("List background jobs", args, theme, context), renderResult: renderJobList,
  });
  const writeParameters = Type.Object({ purpose: toolPurposeParameter, id: Type.String(), text: Type.String({ maxLength: 16000 }), eof: Type.Optional(Type.Boolean()), cursor: Type.Optional(Type.Integer({ minimum: 0 })), max_chars: budgetParameter });
  pi.registerTool({
    name: "job_write", label: "Write job input", description: "Write literal input to a job. Pipe jobs need stdin=true at start and support eof=true; PTYs support terminal control bytes (Ctrl+C=\\u0003, Ctrl+D=\\u0004) but not eof=true. PTY terminal echo may repeat input. Input is not a shell command unless the child interprets it.",
    parameters: writeParameters,
    prepareArguments: argumentAliases(writeParameters),
    renderShell: "self",
    async execute(_id, params, signal) { const jobs = service; await jobs.write(params.id, params.text, params.eof, signal); return result(params.id, { cursor: params.cursor, budget: outputBudget(params.max_chars) }, jobs); },
    renderCall: (args, theme, context) => jobHeading(`Write job input · ${safeLabel(args.id)}`, args, theme, context), renderResult,
  });
  const resizeParameters = Type.Object({ purpose: toolPurposeParameter, id: Type.String(), columns: Type.Integer({ minimum: 10, maximum: 500 }), rows: Type.Integer({ minimum: 2, maximum: 200 }) });
  pi.registerTool({
    name: "job_resize", label: "Resize job terminal", description: "Resize a running PTY job. Terminal applications receive the new dimensions; pipe jobs cannot be resized.",
    parameters: resizeParameters,
    prepareArguments: argumentAliases(resizeParameters),
    renderShell: "self",
    async execute(_id, params) { const job = service.resize(params.id, params.columns, params.rows); return result(job.id, { cursor: job.outputEnd, track: false }); },
    renderCall: (args, theme, context) => jobHeading(`Resize terminal · ${safeLabel(args.id)} · ${args.columns}×${args.rows}`, args, theme, context), renderResult,
  });
  const stopParameters = Type.Object({ purpose: toolPurposeParameter, id: Type.String() });
  pi.registerTool({
    name: "job_stop", label: "Stop background job", description: "Stop a managed job and its process group. Sends TERM, then KILL after three seconds if necessary. Safe to repeat for a finished job.",
    parameters: stopParameters,
    prepareArguments: argumentAliases(stopParameters),
    renderShell: "self",
    async execute(_id, params) { const job = findJob(params.id); if (service.list().some((job) => job.id === params.id)) service.stop(params.id); return result(params.id, { cursor: job.outputEnd, track: false, hint: false }); },
    renderCall: (args, theme, context) => jobHeading(`Stop job · ${safeLabel(args.id)}`, args, theme, context), renderResult,
  });

  const show = async (args: string, ctx: ExtensionContext) => {
    if (allJobs().length) controls.activate(JOB_CONTROLS);
    if (historyError) ctx.ui.notify(historyError, "warning");
    const [action, id] = args.trim().split(/\s+/);
    if (action === "stop") {
      if (id === "all") { for (const job of service.list()) if (isActive(job.status)) service.stop(job.id); }
      else if (id) { const job = findJob(id); if (isActive(job.status)) service.stop(id); }
      else { ctx.ui.notify("Usage: /jobs stop <id|all>", "error"); return; }
      ctx.ui.notify("Stop requested. Jobs remain visible until their processes exit.", "info");
      return;
    }
    if (action && action !== "output") { ctx.ui.notify("Usage: /jobs [output <id>|stop <id|all>]", "info"); return; }
    if (action === "output" && !id) { ctx.ui.notify("Usage: /jobs output <id>", "error"); return; }
    if (id) findJob(id);
    if (ctx.mode !== "tui") { ctx.ui.notify(allJobs().map((job) => `${job.id} · ${brief(job)}`).join("\n") || "No jobs.", "info"); return; }
    if (viewerOpen) return;
    viewerOpen = true;
    const version = generation;
    pi.events.emit("workflow-overlay:modal", { id: "background-jobs", open: true });
    try {
      await ctx.ui.custom<void>((tui, theme, keys, done) => {
        viewer = new TranscriptView(() => (id ? [findJob(id)] : allJobs()).map((job) => ({
          id: job.id, label: `${brief(job)} · ${job.id}${job.pty ? ` · PTY ${job.columns}×${job.rows}` : ""}`, kind: "tool", failed: job.status === "failed",
          body: `${job.command}\n${job.cwd}\n${job.error ?? ""}\n${job.tail || "No output yet."}`,
        })), "background jobs", theme, keys, tui, done);
        return viewer;
      }, { overlay: true, overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%", margin: 1 } });
    } finally {
      if (version === generation) { viewer = undefined; viewerOpen = false; clearRefresh(); pi.events.emit("workflow-overlay:modal", { id: "background-jobs", open: false }); }
    }
  };
  pi.registerCommand("jobs", { description: "Inspect or stop managed jobs: /jobs [output <id>|stop <id|all>]", handler: show });
  pi.registerCommand("ps", { description: "Alias for /jobs", handler: show });

  pi.on("session_start", async (_event, ctx) => {
    controls.initialize();
    generation++;
    historyReady = false;
    await service.shutdown();
    history.load(ctx.sessionManager.getBranch(), () => ctx.sessionManager.getBranch());
    historyReady = true;
    closing = false;
    historyError = undefined;
    service = new JobService(3000, knownSecretValues); listen();
    if (ctx.mode !== "tui") return;
    card = registerOverlayCard({ id: "background-jobs", order: 40, minTerminalWidth: 90, minTerminalHeight: 12,
      visible: () => service.list().some((job) => isActive(job.status)),
      title: (theme) => theme.fg("accent", " Jobs · /jobs "),
      renderBody: (_width, height, theme) => {
        const active = service.list().filter((job) => isActive(job.status));
        const count = Math.min(3, Math.max(0, height - (active.length > height ? 1 : 0)));
        return [...active.slice(0, count).map((job) => theme.fg("muted", `${icons[job.status]} ${job.name}`)),
          ...(active.length > count && height > count ? [theme.fg("dim", `+${active.length - count} more · /jobs`)] : [])];
      },
    });
  });
  pi.on("session_shutdown", async () => {
    unsubscribeOwner();
    generation++; clearRefresh(); viewer?.close(); viewer = undefined; viewerOpen = false;
    closing = true;
    completionViews.clear();
    card?.unregister(); card = undefined;
    await service.shutdown();
    history.freeze();
    unsubscribe?.(); historyReady = false;
  });
}
