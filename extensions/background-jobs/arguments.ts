import { MAX_WAIT_MS } from "./service.ts";

export const DEFAULT_YIELD_MS = 10_000;
export const START_YIELD_MS = 1000;
/** job_write waits this long for a reply by default. */
export const WRITE_WAIT_MS = 5000;
export const MAX_YIELD_MS = 30_000;
export const DEFAULT_OUTPUT_CHARS = 24_000;
export const MIN_OUTPUT_CHARS = 200;
export const MAX_OUTPUT_CHARS = 50_000;
/** Rough characters per token used to translate token budgets into character budgets. */
export const CHARS_PER_TOKEN = 4;

/** Clamp a numeric argument instead of rejecting it; missing or invalid values use the fallback. */
export function clampNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
}
export const outputBudget = (value: unknown) => clampNumber(value, DEFAULT_OUTPUT_CHARS, MIN_OUTPUT_CHARS, MAX_OUTPUT_CHARS);
export const yieldDuration = (value: unknown, fallback = DEFAULT_YIELD_MS) => clampNumber(value, fallback, 0, MAX_YIELD_MS);
export const waitDuration = (value: unknown, fallback: number) => clampNumber(value, fallback, 0, MAX_WAIT_MS);

const tokens = (value: unknown) => {
  const count = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof count === "number" && Number.isFinite(count) ? Math.round(count * CHARS_PER_TOKEN) : value;
};

/** Common spellings from other shell tool sets, mapped onto this tool's parameter names. */
const ALIASES: readonly (readonly [alias: string, name: string, convert?: (value: unknown) => unknown])[] = [
  ["job_id", "id"], ["jobId", "id"],
  ["waitMs", "wait_ms"], ["wait_time_ms", "wait_ms"],
  ["yield-time_ms", "yield_ms"], ["yield_time_ms", "yield_ms"], ["yieldMs", "yield_ms"],
  // Tools that wait after acting (job_write) take the same spelling as wait_ms.
  ["yield-time_ms", "wait_ms"],
  ["max_output_tokens", "max_chars", tokens], ["maxOutputTokens", "max_chars", tokens], ["maxChars", "max_chars"],
  ["reasoning", "purpose"], ["tty", "pty"], ["chars", "text"], ["close_stdin", "eof"],
  ["timeout", "timeout_seconds"],
];

/**
 * Build a `prepareArguments` shim that renames known aliases when the schema
 * has the canonical parameter and lacks the alias. Canonical values win.
 */
export function argumentAliases(parameters: { properties: Record<string, unknown> }) {
  const known = parameters.properties;
  return (raw: unknown): any => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const args: Record<string, unknown> = { ...raw };
    let changed = false;
    for (const [alias, name, convert] of ALIASES) {
      if (!Object.hasOwn(args, alias) || Object.hasOwn(known, alias) || !Object.hasOwn(known, name)) continue;
      if (args[name] === undefined) args[name] = convert ? convert(args[alias]) : args[alias];
      delete args[alias];
      changed = true;
    }
    // `wait: true` asks a read to block until the job exits (bounded by the wait cap).
    if (Object.hasOwn(args, "wait") && !Object.hasOwn(known, "wait") && Object.hasOwn(known, "wait_ms")) {
      if (args.wait === true && args.wait_ms === undefined) args.wait_ms = MAX_WAIT_MS;
      delete args.wait;
      changed = true;
    }
    return changed ? args : raw;
  };
}
