import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { constants } from "node:os";
import type { StartJob } from "./service.ts";

export type JobProcess = Pick<ChildProcess, "pid" | "stdin" | "stdout" | "stderr" | "kill"> & EventEmitter & {
  resize?: (columns: number, rows: number) => void;
};

export function terminalSize(columns = 100, rows = 30): { columns: number; rows: number } {
  if (!Number.isSafeInteger(columns) || columns < 10 || columns > 500 || !Number.isSafeInteger(rows) || rows < 2 || rows > 200) {
    throw new Error("Terminal size must be 10–500 columns and 2–200 rows.");
  }
  return { columns, rows };
}

/** Adapt native PTY lifecycle to the same stream contract as ordinary pipe jobs. */
export function startProcess(input: StartJob): JobProcess {
  if (!input.pty) return spawn(input.executable, input.args, {
    cwd: input.cwd, env: input.env ?? process.env, shell: false,
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  if (process.versions.bun) throw new Error("PTY jobs require Node.js. Launch Pi with Node.js, or omit pty for a pipe job.");
  const { columns, rows } = terminalSize(input.columns, input.rows);
  const require = createRequire(import.meta.url);
  let native: typeof import("node-pty");
  try { native = require("node-pty"); }
  catch { throw new Error("PTY runtime is unavailable. Reinstall dependencies with install scripts enabled (node-pty requires a native binary)."); }
  const terminal = native.spawn(input.executable, input.args, {
    cwd: input.cwd, env: input.env ?? process.env, cols: columns, rows, name: "xterm-256color", encoding: "utf8",
  });
  const events = new EventEmitter();
  const stdout = new PassThrough();
  let exited = false;
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      try { if (exited) throw new Error("Terminal has exited."); terminal.write(chunk.toString("utf8")); done(); }
      catch (error) { done(error as Error); }
    },
  });
  const data = terminal.onData((chunk) => stdout.write(chunk));
  const exit = terminal.onExit(({ exitCode, signal }) => {
    exited = true;
    data.dispose(); exit.dispose();
    const signalName = signal ? Object.entries(constants.signals).find(([, value]) => value === signal)?.[0] ?? String(signal) : null;
    events.emit("exit", exitCode, signalName);
    // Service stream-end listeners flush redaction before the close observer persists history.
    stdout.end(() => { events.emit("close"); });
    stdin.destroy();
  });
  const processHandle = Object.assign(events, {
    pid: terminal.pid, stdin, stdout, stderr: null,
    kill(signal: NodeJS.Signals | number = "SIGTERM") {
      try { terminal.kill(typeof signal === "string" ? signal : undefined); return true; } catch { return false; }
    },
    resize(cols: number, lines: number) { terminalSize(cols, lines); if (exited) throw new Error("Terminal has exited."); terminal.resize(cols, lines); },
  });
  queueMicrotask(() => events.emit("spawn"));
  return processHandle;
}
