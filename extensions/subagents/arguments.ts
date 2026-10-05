export const DEFAULT_WAIT_MS = 5 * 60_000;
export const MAX_WAIT_MS = 60 * 60_000;

const ACTION_ALIASES: Record<string, string> = { followup: "send", follow_up: "send", message: "queue" };
const CONTEXT_ALIASES: Record<string, string> = { compacted: "summary", forked: "fork" };
const SINGLE_TARGET_ACTIONS = new Set(["send", "queue", "read", "interrupt", "close"]);

/** Clamps a requested wait to [0, MAX_WAIT_MS]; missing or invalid values use the default. */
export function waitTimeout(value: unknown): number {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof number !== "number" || Number.isNaN(number)) return DEFAULT_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(0, Math.floor(number)));
}

/**
 * Accepts argument shapes models commonly carry over from similar agent tools
 * without widening the published schema: action and context synonyms, agent id
 * fields, `return_when`, and out-of-range wait timeouts.
 */
export function prepareSubagentArguments(raw: unknown): any {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { agent_id, agent_ids, return_when, ...args } = raw as Record<string, unknown>;
  if (typeof args.action === "string") {
    const action = args.action.trim().toLowerCase();
    args.action = ACTION_ALIASES[action] ?? action;
  }
  if (typeof args.context === "string") {
    const context = args.context.trim().toLowerCase();
    args.context = CONTEXT_ALIASES[context] ?? context;
  }
  if (args.agent_name === undefined && typeof agent_id === "string") args.agent_name = agent_id;
  if (args.agent_names === undefined && Array.isArray(agent_ids)) args.agent_names = agent_ids;
  if (args.wait_mode === undefined && typeof return_when === "string") args.wait_mode = return_when.trim().toLowerCase();
  if (typeof args.wake_on === "string") args.wake_on = args.wake_on.trim().toLowerCase();

  if (args.action === "wait") {
    if (args.agent_names === undefined) {
      const single = args.agent_name ?? args.name;
      if (typeof single === "string") args.agent_names = [single];
    }
    if (typeof args.agent_names === "string") args.agent_names = [args.agent_names];
    if (args.timeout_ms !== undefined && args.timeout_ms !== null) args.timeout_ms = waitTimeout(args.timeout_ms);
    else delete args.timeout_ms;
  } else if (SINGLE_TARGET_ACTIONS.has(String(args.action)) && args.agent_name === undefined) {
    if (typeof args.name === "string") args.agent_name = args.name;
    else if (Array.isArray(args.agent_names) && args.agent_names.length === 1) args.agent_name = args.agent_names[0];
  }
  return args;
}
