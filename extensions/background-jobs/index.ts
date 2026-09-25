import { getShellConfig, type ExtensionAPI, type ExtensionContext, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { registerOverlayCard, type OverlayCardHandle } from "../overlay-stack/index.ts";
import { TranscriptView } from "../../lib/transcript/view.ts";
import { elapsed } from "../working-status/state.ts";
import { JobService, isActive, type JobSnapshot } from "./service.ts";
import { knownSecretValues } from "../questions/secrets.ts";
import { PlainOutput } from "../../lib/output.ts";
import { redactText } from "../../lib/redact.ts";
import { BASH_OWNER, BASH_STYLE, type BashOwnerRequest, type BashStyleRequest, type BashStyle } from "./bash-style.ts";
import { JOB_HISTORY_ENTRY, JobHistory } from "./history.ts";
import { deferredTools } from "../../lib/deferred-tools.ts";
import { commandPurposeParameter, COMMAND_PURPOSE_GUIDELINE, toolPurpose, toolPurposeParameter } from "../../lib/tool-purpose.ts";
const JOB_CONTROLS = ["job_output", "job_wait", "job_list", "job_write", "job_resize", "job_stop"];

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

const icons: Record<JobSnapshot["status"], string> = { starting: "◌", running: "●", stopping: "◌", completed: "✓", failed: "×", stopped: "■", "timed-out": "◷", interrupted: "?" };
const exitSummary = (job: JobSnapshot) => job.signal ? ` · ${job.signal}` : job.code != null ? ` · exit ${job.code}` : "";
const brief = (job: JobSnapshot) => `${icons[job.status]} ${job.name} · ${job.status} · ${job.status === "interrupted" ? "completion unknown" : elapsed((job.endedAt ?? Date.now()) - job.startedAt)}${exitSummary(job)}`;
const safeLabel = (text: unknown) => redactText(new PlainOutput().push(typeof text === "string" ? text : "").replace(/\s+/g, " "), knownSecretValues());
// Redact before the display cap so a secret crossing that cap stays hidden.
const safePurpose = (value: unknown, targets: readonly unknown[] = []) => toolPurpose(
  safeLabel(typeof value === "string" ? value.replace(/\p{Bidi_Control}/gu, "") : ""), targets.map(safeLabel),
);

function lines(text: string) {
  return { invalidate() {}, render: (width: number) => width > 0 ? text.split("\n").map((line) => truncateToWidth(line, width, "…")) : [] };
}

function jobHeading(title: string, args: Record<string, unknown>, theme: Theme) {
  const purpose = safePurpose(args.purpose, [args.id, args.name, args.command]);
  return lines(theme.fg("muted", title) + (purpose ? theme.fg("dim", " · ") + theme.fg("text", purpose) : ""));
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
    return [...active, ...ended.slice(-Math.max(0, 24 - active.length))];
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

  const result = (id: string, cursor?: number, source = service) => {
    const live = source.list().find((job) => job.id === id);
    const job = live ?? findJob(id);
    const output = live ? source.output(id, cursor) : (() => {
      const start = job.outputEnd - job.tail.length;
      const from = cursor ?? start;
      if (!Number.isSafeInteger(from) || from < 0 || from > job.outputEnd) throw new Error("Invalid historical output cursor.");
      let offset = Math.max(0, from - start);
      const code = job.tail.charCodeAt(offset);
      if (code >= 0xdc00 && code <= 0xdfff) offset++;
      return { text: job.tail.slice(offset), cursor: job.outputEnd, lost: start + offset - from, more: false };
    })();
    const text = `${brief(job)}\nJob: ${id} · cursor: ${output.cursor}${output.more ? " · more output available" : ""}`
      + (output.lost ? `\n${output.lost} older characters were evicted from the bounded log.` : "")
      + (job.error ? `\n${job.error}` : "")
      + (!live ? "\nHistorical record: only the saved output tail is available; no process was resumed." : "")
      + `\n\n${output.text || "No new output."}`;
    return { content: [{ type: "text" as const, text }], details: { managed: true, id, name: job.name, status: job.status, exitCode: job.code, signal: job.signal, cursor: output.cursor, more: output.more, lost: output.lost } };
  };
  const renderResult = (value: any, options: { expanded: boolean; isPartial: boolean }, theme: Theme, _context?: ToolRenderContext) => {
    if (options.isPartial && !value.content?.length) return lines(theme.fg("muted", "Waiting for job…"));
    const text = value.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "";
    if (options.expanded) return lines(text);
    const rows = text.split("\n");
    return lines([theme.fg(value.details?.status === "failed" ? "error" : "muted", rows[0] ?? "Job result"),
      ...(rows.length > 9 ? [theme.fg("dim", `… ${rows.length - 9} lines hidden`)] : []), ...rows.slice(Math.max(1, rows.length - 8))].join("\n"));
  };
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

  const startManaged = async (params: { command: string; name: string; pty?: boolean; columns?: number; rows?: number; yield_ms?: number; timeout_seconds?: number }, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: (result: any) => void) => {
      const shell = getShellConfig();
      const env = { ...process.env };
      for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
      env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
      const file = ctx.sessionManager.getSessionFile();
      if (file) env.PI_SESSION_FILE = file;
      if (ctx.model) { env.PI_PROVIDER = ctx.model.provider; env.PI_MODEL = ctx.model.id; }
      env.PI_REASONING_LEVEL = pi.getThinkingLevel();
      const jobs = service;
      const job = jobs.start({ pty: params.pty, columns: params.columns, rows: params.rows, command: params.command, name: params.name, cwd: ctx.cwd, executable: shell.shell, args: [...shell.args, params.command], env, timeoutMs: params.timeout_seconds === undefined ? undefined : params.timeout_seconds * 1000 }, signal);
      let refresh: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const publish = () => {
        if (stopped || signal?.aborted || !onUpdate) return;
        const snapshot = jobs.get(job.id);
        const value = result(job.id, Math.max(0, snapshot.outputEnd - 8192), jobs);
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
      try { await jobs.wait(job.id, params.yield_ms ?? 1000, signal); }
      catch (error) { jobs.stop(job.id); throw error; }
      finally { stopped = true; unsubscribe?.(); if (refresh) clearTimeout(refresh); if (ticker) clearInterval(ticker); }
      if (isActive(jobs.get(job.id).status)) controls.activate(JOB_CONTROLS);
      return result(job.id, 0, jobs);
  };

  let bashStyle: BashStyle | undefined;
  const bashDefinition = (): ToolDefinition<any> => ({
    name: "bash", label: "bash",
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    description: "Execute a managed shell command in the current working directory. Short commands finish inline; after yield_ms (default 1000, maximum 30000) a running command returns a job ID. Use job_wait/job_output, job_write, job_resize and job_stop to control it. Optional timeout is in seconds. Use pty for interactive terminal programs (Node.js required). Keep commands in the foreground; do not use nohup/disown/setsid.",
    promptSnippet: "Execute shell commands; long commands yield managed job IDs for follow-up.",
    promptGuidelines: ["A yielded bash job is still running. Use job_wait to check its exit status before treating the command as successful.", COMMAND_PURPOSE_GUIDELINE],
    parameters: Type.Object({ purpose: commandPurposeParameter, command: Type.String({ minLength: 1, maxLength: 16000 }), timeout: Type.Optional(Type.Number({ minimum: 0.1, maximum: 86400 })), yield_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })), pty: Type.Optional(Type.Boolean()), columns: Type.Optional(Type.Integer({ minimum: 10, maximum: 500 })), rows: Type.Optional(Type.Integer({ minimum: 2, maximum: 200 })), name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })) }),
    async execute(_id, params: any, signal, update, ctx) {
      const { purpose: _purpose, ...execution } = params;
      const value = await startManaged({ ...execution, name: execution.name ?? "Shell command", timeout_seconds: execution.timeout }, signal, ctx, update);
      if (["failed", "timed-out", "stopped"].includes(value.details.status)) throw new Error(value.content[0].text);
      return value;
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

  pi.registerTool({
    name: "job_start", label: "Start background job",
    description: "Start a managed shell command. It may finish during yield_ms or keep running with a job ID. Use job_wait/job_output cursors, job_write for stdin, and job_stop for cleanup. Run the command in the foreground; do not use nohup/disown/setsid. Set pty=true for interactive terminal programs (Node.js required); otherwise uses pipes. PTY output is a sanitized text log, not a screen emulator.",
    promptSnippet: "Run long-lived commands as managed background jobs with bounded logs and explicit cleanup.",
    parameters: Type.Object({ purpose: toolPurposeParameter, pty: Type.Optional(Type.Boolean()), columns: Type.Optional(Type.Integer({ minimum: 10, maximum: 500 })), rows: Type.Optional(Type.Integer({ minimum: 2, maximum: 200 })), command: Type.String({ minLength: 1, maxLength: 16000 }), name: Type.String({ minLength: 1, maxLength: 80 }), yield_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })), timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400 })) }),
    async execute(_id, params, signal, update, ctx) {
      const { purpose: _purpose, ...execution } = params;
      return startManaged(execution, signal, ctx, update);
    },
    renderCall: (args, theme) => jobHeading(`Start job · ${safeLabel(args.name) || "command"}`, args, theme), renderResult: renderStartResult,
  });
  const readParameters = Type.Object({ purpose: toolPurposeParameter, id: Type.String(), cursor: Type.Optional(Type.Integer({ minimum: 0 })), wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })) });
  for (const name of ["job_output", "job_wait"] as const) pi.registerTool({
    name, label: name === "job_wait" ? "Wait for job" : "Read job output",
    description: "Read managed job output. Pass the last returned cursor to avoid repeating output. job_wait waits up to wait_ms (default 1000); cancelling a wait leaves the job running.",
    parameters: readParameters,
    async execute(_id, params, signal) {
      const jobs = service;
      if (jobs.list().some((job) => job.id === params.id)) await jobs.wait(params.id, params.wait_ms ?? (name === "job_wait" ? 1000 : 0), signal);
      else signal?.throwIfAborted();
      return result(params.id, params.cursor, jobs);
    },
    renderCall: (args, theme) => jobHeading(`${name === "job_wait" ? "Wait for" : "Read"} job · ${safeLabel(args.id)}`, args, theme), renderResult,
  });
  pi.registerTool({
    name: "job_list", label: "List background jobs", description: "List this session's managed jobs and their IDs, including recent finished jobs. Use job_output for logs.",
    parameters: Type.Object({ purpose: toolPurposeParameter }),
    async execute() {
      const jobs = allJobs();
      return { content: [{ type: "text", text: jobs.map((job) => `${job.id} · ${brief(job)}\n${job.command.slice(0, 180)}`).join("\n\n") || "No managed jobs in this session." }],
        details: { jobs: jobs.map(({ id, name, status }) => ({ id, name, status })) } };
    },
    renderCall: (args, theme) => jobHeading("List background jobs", args, theme), renderResult,
  });
  pi.registerTool({
    name: "job_write", label: "Write job input", description: "Write literal input to a job. Pipe jobs support eof=true; PTYs support terminal control bytes (Ctrl+C=\\u0003, Ctrl+D=\\u0004) but not eof=true. PTY terminal echo may repeat input. Input is not a shell command unless the child interprets it.",
    parameters: Type.Object({ purpose: toolPurposeParameter, id: Type.String(), text: Type.String({ maxLength: 16000 }), eof: Type.Optional(Type.Boolean()), cursor: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, params, signal) { const jobs = service; await jobs.write(params.id, params.text, params.eof, signal); return result(params.id, params.cursor, jobs); },
    renderCall: (args, theme) => jobHeading(`Write job input · ${safeLabel(args.id)}`, args, theme), renderResult,
  });
  pi.registerTool({
    name: "job_resize", label: "Resize job terminal", description: "Resize a running PTY job. Terminal applications receive the new dimensions; pipe jobs cannot be resized.",
    parameters: Type.Object({ purpose: toolPurposeParameter, id: Type.String(), columns: Type.Integer({ minimum: 10, maximum: 500 }), rows: Type.Integer({ minimum: 2, maximum: 200 }) }),
    async execute(_id, params) { const job = service.resize(params.id, params.columns, params.rows); return result(job.id, job.outputEnd); },
    renderCall: (args, theme) => jobHeading(`Resize terminal · ${safeLabel(args.id)} · ${args.columns}×${args.rows}`, args, theme), renderResult,
  });
  pi.registerTool({
    name: "job_stop", label: "Stop background job", description: "Stop a managed job and its process group. Sends TERM, then KILL after three seconds if necessary. Safe to repeat for a finished job.",
    parameters: Type.Object({ purpose: toolPurposeParameter, id: Type.String() }),
    async execute(_id, params) { const job = findJob(params.id); if (service.list().some((job) => job.id === params.id)) service.stop(params.id); return result(params.id, job.outputEnd); },
    renderCall: (args, theme) => jobHeading(`Stop job · ${safeLabel(args.id)}`, args, theme), renderResult,
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
