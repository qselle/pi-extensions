import { stat } from "node:fs/promises";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { PlainOutput } from "../../lib/output.ts";
import { request, socketIdentity, type Method, type Request } from "./transport.ts";

export const ENTRY = "terminal-processes:owned-pane";
export type Action = "start" | "list" | "read" | "status" | "input" | "interrupt";
export interface Args {
  action: Action; command?: string; label?: string; direction?: "right" | "down";
  pane_id?: string; lines?: number; text?: string; press_enter?: boolean; purpose?: string;
}
export interface Record {
  version: 1; sessionId: string; socketKey: string; paneId: string; terminalId: string;
  label: string; direction: "right" | "down"; stage: "created" | "unconfirmed" | "submitted";
}
export interface Context {
  mode: string; cwd: string;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined; getEntries(): readonly any[] };
}
interface Options { env?: NodeJS.ProcessEnv; request?: Request; identity?: typeof socketIdentity }
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(value);
export const plain = (text: string): string => new PlainOutput().push(text).replace(/\p{Bidi_Control}/gu, "");
const labelText = (text: string): string => Array.from(plain(text).replace(/\s+/g, " ").trim()).slice(0, 80).join("");

function restored(value: unknown, sessionId: string): Record | undefined {
  const record = value as Record;
  if (!record || record.version !== 1 || record.sessionId !== sessionId || !/^[a-f0-9]{64}$/.test(record.socketKey)
    || !validId(record.paneId) || !validId(record.terminalId) || typeof record.label !== "string" || record.label.length > 160
    || !["right", "down"].includes(record.direction) || !["created", "unconfirmed", "submitted"].includes(record.stage)) return;
  return { ...record, label: labelText(record.label) };
}

function pane(value: any): { pane_id: string; terminal_id: string; tab_id: string } {
  const result = value?.pane;
  if (value?.type !== "pane_info" || !validId(result?.pane_id) || !validId(result?.terminal_id) || !validId(result?.tab_id)) {
    throw new Error("Herdr did not return a usable pane identity.");
  }
  return result;
}

/** Session-wide ownership deliberately survives tree navigation, but never a fork. */
export class TerminalProcesses {
  private epoch = 0;
  private controller = new AbortController();
  private context?: Context;
  private sessionId = "";
  private readonly records = new Map<string, Record>();
  private busy = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly send: Request;
  private readonly identity: typeof socketIdentity;
  constructor(private readonly append: (data: Record) => void, options: Options = {}) {
    this.env = options.env ?? process.env;
    this.send = options.request ?? request;
    this.identity = options.identity ?? socketIdentity;
  }

  available(ctx: Context): boolean {
    return ctx.mode === "tui" && this.env.HERDR_ENV === "1" && this.env.PI_SUBAGENT_CHILD !== "1"
      && !!this.env.HERDR_SOCKET_PATH && !!this.env.HERDR_PANE_ID && process.platform !== "win32";
  }
  restore(ctx: Context): void {
    this.stop();
    this.context = ctx;
    this.sessionId = ctx.sessionManager.getSessionId();
    this.records.clear();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      const record = restored(entry.data, this.sessionId);
      if (record) this.records.set(record.paneId, record);
    }
  }
  stop(): void {
    this.epoch++;
    this.controller.abort();
    this.controller = new AbortController();
    this.context = undefined;
    // Herdr owns the PTYs. Never interrupt or close anything here.
  }

  async execute(args: Args, ctx: Context, callerSignal?: AbortSignal) {
    if (!this.available(ctx)) throw new Error("Terminal processes require a Herdr-managed Pi TUI and its Unix socket.");
    if (!this.context || this.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("The Pi session changed; retry in the current session.");
    if (this.busy) throw new Error("Another terminal operation is in progress.");
    this.busy = true;
    const epoch = this.epoch, sessionId = this.sessionId;
    const signal = AbortSignal.any([this.controller.signal, ...(callerSignal ? [callerSignal] : [])]);
    const check = () => {
      signal.throwIfAborted();
      if (epoch !== this.epoch || ctx.sessionManager.getSessionId() !== sessionId) throw new Error("The Pi session changed; terminal operation cancelled.");
    };
    const path = this.env.HERDR_SOCKET_PATH!;
    const save = (record: Record) => {
      check();
      this.append({ ...record }); // Persist ownership before sending a command.
      this.records.set(record.paneId, record);
    };
    try {
      check();
      if (args.action === "list") {
        const lines = [...this.records.values()].map((record) => `${record.paneId} · ${record.label} · ${record.stage === "submitted" ? "command submitted" : record.stage === "created" ? "pane created; command not submitted" : "launch unconfirmed; inspect before retrying"}`);
        return this.result(args.action, lines.join("\n") || "No terminal panes are owned by this Pi session.");
      }
      const socketKey = await this.identity(path); check();
      const call = async (method: Method, params: { [key: string]: unknown }) => {
        check();
        if (await this.identity(path) !== socketKey) throw new Error("Herdr socket changed; no terminal action was submitted.");
        check();
        const result = await this.send(path, method, params, signal);
        check();
        return result;
      };
      const owned = async (record: Record) => {
        if (record.socketKey !== socketKey) throw new Error("This pane belongs to a different Herdr server instance; control it manually.");
        const current = pane(await call("pane.get", { pane_id: record.paneId }));
        if (current.terminal_id !== record.terminalId) throw new Error("Pane identity changed; refusing to control a different terminal.");
        return current;
      };
      if (args.action === "start") {
        if (typeof args.command !== "string" || !args.command.trim() || args.command.includes("\0") || Buffer.byteLength(args.command) > 64 * 1024) {
          throw new Error("start requires a nonempty command of at most 64 KiB, without NUL bytes.");
        }
        if (args.direction !== undefined && !["right", "down"].includes(args.direction)) throw new Error("direction must be right or down.");
        const file = ctx.sessionManager.getSessionFile();
        if (!file || !(await stat(file).catch(() => undefined))?.isFile()) {
          throw new Error("A saved Pi session is required so terminal ownership survives exit.");
        }
        check();
        const origin = pane(await call("pane.get", { pane_id: this.env.HERDR_PANE_ID! }));
        let direction = args.direction;
        if (!direction) {
          const previous = [...this.records.values()].filter((record) => record.socketKey === socketKey).at(-1)?.direction;
          if (previous) direction = previous === "right" ? "down" : "right";
          else {
            direction = "right";
            try {
              const layout = await call("pane.layout", { pane_id: origin.pane_id });
              const rect = layout?.layout?.panes?.find((item: any) => item.pane_id === origin.pane_id)?.rect;
              if (Number.isFinite(rect?.width) && Number.isFinite(rect?.height) && rect.height > 0) direction = rect.width / rect.height >= 2 ? "right" : "down";
            } catch { check(); } // Layout is optional; cancellation is not.
          }
        }
        const child = pane(await call("pane.split", { target_pane_id: origin.pane_id, direction, cwd: ctx.cwd, focus: false }));
        if (child.terminal_id === origin.terminal_id || child.pane_id === origin.pane_id || child.tab_id !== origin.tab_id) {
          throw new Error("Herdr did not return a distinct sibling pane; no command was submitted.");
        }
        const record: Record = { version: 1, sessionId, socketKey, paneId: child.pane_id, terminalId: child.terminal_id,
          label: labelText(args.label ?? "Terminal process") || "Terminal process", direction, stage: "created" };
        save(record);
        let warning = "";
        try { await call("pane.rename", { pane_id: child.pane_id, label: record.label }); }
        catch { check(); warning = " Pane label could not be updated."; }
        const current = await owned(record);
        save({ ...record, stage: "unconfirmed" });
        const acknowledgement = await call("pane.send_input", { pane_id: current.pane_id, text: args.command, keys: ["Enter"] });
        if (acknowledgement.type !== "ok") throw new Error("Command submission was not acknowledged; inspect the pane before retrying.");
        save({ ...record, stage: "submitted" });
        return this.result(args.action, `Command submitted in ${record.label} (${record.paneId}).${warning} Use status/read to inspect it.`, record);
      }
      const record = typeof args.pane_id === "string" ? this.records.get(args.pane_id) : undefined;
      if (!record) throw new Error("Use a pane_id returned by this Pi session's terminal_process start/list.");
      const current = await owned(record);
      if (args.action === "read") {
        const lines = args.lines ?? 120;
        if (!Number.isInteger(lines) || lines < 1 || lines > DEFAULT_MAX_LINES) throw new Error(`lines must be 1–${DEFAULT_MAX_LINES}.`);
        const read = async (source: string) => {
          const result = await call("pane.read", { pane_id: current.pane_id, source, lines, format: "text", strip_ansi: true });
          if (result?.type !== "pane_read" || result.read?.pane_id !== current.pane_id || typeof result.read?.text !== "string") throw new Error("Unsupported Herdr output response.");
          return result.read;
        };
        let output = await read("recent_unwrapped");
        if (!output.text.trim()) output = await read("visible");
        const limited = truncateTail(plain(output.text), { maxLines: lines, maxBytes: DEFAULT_MAX_BYTES });
        const truncated = limited.truncated || output.truncated === true;
        return this.result(args.action, (limited.content || "(no pane output)") + (truncated ? "\n[Output limited; inspect the visible pane for more.]" : ""), record, truncated);
      }
      if (args.action === "status") {
        const result = await call("pane.process_info", { pane_id: current.pane_id });
        if (result?.type !== "pane_process_info" || result.process_info?.pane_id !== current.pane_id
          || (result.process_info.foreground_processes !== undefined && !Array.isArray(result.process_info.foreground_processes))) throw new Error("Unsupported Herdr process response.");
        // Names and PIDs are sufficient; argv/cmdline can contain input secrets.
        const processes = (result.process_info.foreground_processes ?? []).slice(0, 100).map((process: any) => `${labelText(typeof process?.name === "string" ? process.name : "process")}${Number.isSafeInteger(process?.pid) ? ` (PID ${process.pid})` : ""}`);
        return this.result(args.action, processes.join("\n") || "No foreground process is reported. The pane remains open; no exit status is inferred.", record);
      }
      if (args.action === "input" || args.action === "interrupt") {
        const text = args.text ?? "";
        if (args.action === "input" && (typeof text !== "string" || text.includes("\0") || Buffer.byteLength(text) > 64 * 1024 || (!text && args.press_enter === false))) throw new Error("input requires text or Enter, at most 64 KiB, without NUL bytes.");
        const result = await call("pane.send_input", { pane_id: current.pane_id,
          text: args.action === "input" ? text : "", keys: args.action === "interrupt" ? ["ctrl+c"] : args.press_enter === false ? [] : ["Enter"] });
        if (result.type !== "ok") throw new Error("Input was not acknowledged; inspect the pane before retrying.");
        return this.result(args.action, `${args.action === "input" ? "Input" : "Ctrl+C"} sent to ${record.paneId}.`, record);
      }
      throw new Error("Unknown terminal process action.");
    } finally { this.busy = false; }
  }

  private result(action: Action, text: string, record?: Record, truncated = false) {
    const bounded = truncateTail(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
    return { content: [{ type: "text" as const, text: bounded.content }], details: { action,
      ...(record ? { paneId: record.paneId, label: record.label } : {}), truncated: truncated || bounded.truncated } };
  }
}
