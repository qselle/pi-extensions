import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  applyTemplate,
  combineOutput,
  formatFailure,
  shellInvocation,
  spillOutput,
} from "./command.ts";
import type { VerifyCheck } from "./config.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed?: boolean;
}

export type Exec = (
  command: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

export interface CheckOutcome {
  ok: boolean;
  /** Failure text to append to the tool result; undefined when ok or aborted. */
  text?: string;
  command: string;
  checkName: string;
  code: number | null;
  timedOut: boolean;
  /** True when the run was cancelled (Esc), which must not report a failure. */
  aborted: boolean;
  durationMs: number;
  cached: boolean;
  spillPath?: string;
}

/**
 * Caches outcomes within a turn, keyed by the command plus the edited file's
 * fingerprint, so a repeated identical invocation is not re-run while a genuine
 * new edit always is.
 */
export class VerifyCache {
  private readonly entries = new Map<string, CheckOutcome>();

  get(key: string): CheckOutcome | undefined {
    return this.entries.get(key);
  }

  set(key: string, outcome: CheckOutcome): void {
    this.entries.set(key, outcome);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Cheap content fingerprint; a missing file gets a stable marker so caching stays deterministic. */
export function fileFingerprint(absolutePath: string, stat: typeof statSync = statSync): string {
  try {
    const info = stat(absolutePath);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "missing";
  }
}

export function cacheKey(command: string, fingerprint: string): string {
  return `${command}\u0000${fingerprint}`;
}

export interface RunCheckOptions {
  check: VerifyCheck;
  /** Repo-relative path of the edited file. */
  file: string;
  cwd: string;
  spillTokenLimit: number;
  exec: Exec;
  signal?: AbortSignal;
  cache?: VerifyCache;
  fingerprint?: string;
  now?: () => number;
  spillDirectory?: string;
}

export async function runCheck(options: RunCheckOptions): Promise<CheckOutcome> {
  const { check, file, cwd, exec, cache } = options;
  const now = options.now ?? Date.now;
  const command = applyTemplate(check.command, { file, dir: dirname(file) || "." });
  const fingerprint = options.fingerprint ?? fileFingerprint(join(cwd, file));
  const key = cacheKey(command, fingerprint);

  const cached = cache?.get(key);
  if (cached) return { ...cached, cached: true };

  const invocation = shellInvocation(command);
  const startedAt = now();
  let result: ExecResult;
  try {
    result = await exec(invocation.command, invocation.args, {
      cwd,
      signal: options.signal,
      timeout: check.timeoutMs,
    });
  } catch (error) {
    // A failing spawn is a configuration problem, reported as-is rather than
    // being mistaken for a failing check.
    const outcome: CheckOutcome = {
      ok: false,
      text: formatFailure({
        check,
        command,
        code: null,
        timedOut: false,
        output: `could not run the check: ${error instanceof Error ? error.message : String(error)}`,
      }),
      command,
      checkName: check.name,
      code: null,
      timedOut: false,
      aborted: false,
      durationMs: now() - startedAt,
      cached: false,
    };
    cache?.set(key, outcome);
    return outcome;
  }

  const durationMs = now() - startedAt;
  if (options.signal?.aborted) {
    // Esc cancelled the turn; do not inject a failure the user caused.
    return {
      ok: true, command, checkName: check.name, code: result.code,
      timedOut: false, aborted: true, durationMs, cached: false,
    };
  }

  if (result.code === 0) {
    const outcome: CheckOutcome = {
      ok: true, command, checkName: check.name, code: 0,
      timedOut: false, aborted: false, durationMs, cached: false,
    };
    cache?.set(key, outcome);
    return outcome;
  }

  const timedOut = Boolean(result.killed);
  const combined = combineOutput(result.stdout ?? "", result.stderr ?? "");
  const spilled = spillOutput(combined, {
    tokenLimit: options.spillTokenLimit,
    directory: options.spillDirectory,
  });
  const outcome: CheckOutcome = {
    ok: false,
    text: formatFailure({
      check,
      command,
      code: result.code,
      timedOut,
      output: spilled.text,
      spillPath: spilled.path,
    }),
    command,
    checkName: check.name,
    code: result.code,
    timedOut,
    aborted: false,
    durationMs,
    cached: false,
    spillPath: spilled.path,
  };
  cache?.set(key, outcome);
  return outcome;
}
