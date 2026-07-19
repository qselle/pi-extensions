export const MAX_GOAL_OBJECTIVE_CHARS = 4_000;
export const MAX_GOAL_CHECKS = 8;
export const MAX_GOAL_CHECK_CHARS = 240;
export const BLOCKED_AUDIT_TURNS = 3;
export const NO_TOOL_TURN_LIMIT = 3;

export type GoalStatus =
  | "active"
  | "paused"
  | "stalled"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

export type GoalCheckStatus = "pending" | "in_progress" | "complete" | "cancelled";

export interface GoalCheck {
  content: string;
  status: GoalCheckStatus;
}

export interface GoalBlockerAudit {
  fingerprint: string;
  description: string;
  evidence?: string;
  nextInput?: string;
  count: number;
  lastReportedTurn: number;
}

export interface GoalState {
  id: string;
  objective: string;
  status: GoalStatus;
  checks: GoalCheck[];
  progressSummary?: string;
  stallReason?: string;
  blockerAudit?: GoalBlockerAudit;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedMs: number;
  turns: number;
  runTurns: number;
  continuations: number;
  noToolTurns: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalEntry {
  version: 2;
  goal: GoalState | null;
}

export interface BlockerInput {
  description: string;
  evidence?: string;
  nextInput?: string;
}

export interface BlockerOutcome {
  goal: GoalState;
  duplicate: boolean;
  blocked: boolean;
}

interface CreateGoalOptions {
  id?: string;
  now?: number;
  tokenBudget?: number | null;
  initialTurn?: boolean;
  checks?: GoalCheck[];
}

export function createGoal(objective: string, options: CreateGoalOptions = {}): GoalState {
  const normalizedObjective = validateObjective(objective);
  const tokenBudget = validateTokenBudget(options.tokenBudget ?? null);
  const now = options.now ?? Date.now();
  const initialTurn = options.initialTurn === true;

  return {
    id: options.id ?? crypto.randomUUID(),
    objective: normalizedObjective,
    status: "active",
    checks: validateGoalChecks(options.checks ?? []),
    tokenBudget,
    tokensUsed: 0,
    timeUsedMs: 0,
    turns: initialTurn ? 1 : 0,
    runTurns: initialTurn ? 1 : 0,
    continuations: 0,
    noToolTurns: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function validateObjective(objective: string): string {
  const normalized = objective.trim();
  if (!normalized) throw new Error("Goal objective must not be empty.");
  if ([...normalized].length > MAX_GOAL_OBJECTIVE_CHARS) {
    throw new Error(`Goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters.`);
  }
  return normalized;
}

export function validateTokenBudget(tokenBudget: number | null): number | null {
  if (tokenBudget === null) return null;
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) {
    throw new Error("Goal token budget must be a positive integer.");
  }
  return tokenBudget;
}

export function validateGoalChecks(checks: readonly GoalCheck[]): GoalCheck[] {
  if (checks.length > MAX_GOAL_CHECKS) throw new Error(`A goal can have at most ${MAX_GOAL_CHECKS} checks.`);
  const normalized = checks.map((check) => {
    const content = check.content.trim();
    if (!content) throw new Error("Goal checks must not be empty.");
    if ([...content].length > MAX_GOAL_CHECK_CHARS) {
      throw new Error(`Goal checks must be at most ${MAX_GOAL_CHECK_CHARS} characters.`);
    }
    if (!isGoalCheckStatus(check.status)) throw new Error(`Unknown goal check status: ${check.status}`);
    return { content, status: check.status };
  });
  const inProgress = normalized.filter((check) => check.status === "in_progress").length;
  const unfinished = normalized.filter((check) => check.status === "pending" || check.status === "in_progress").length;
  if (inProgress > 1) throw new Error("Only one goal check may be in progress at a time.");
  if (unfinished > 0 && inProgress !== 1) {
    throw new Error("Unfinished goal progress must have exactly one in-progress check.");
  }
  return normalized;
}

export function beginGoalRun(goal: GoalState, continuation: boolean, now = Date.now()): GoalState {
  if (goal.status !== "active") return goal;
  return {
    ...goal,
    turns: goal.turns + 1,
    runTurns: goal.runTurns + 1,
    continuations: goal.continuations + (continuation ? 1 : 0),
    updatedAt: now,
  };
}

export function accountGoalUsage(
  goal: GoalState,
  usage: { tokens?: number; timeMs?: number },
  now = Date.now(),
): GoalState {
  const tokensUsed = goal.tokensUsed + normalizeCounter(usage.tokens);
  const timeUsedMs = goal.timeUsedMs + normalizeCounter(usage.timeMs);
  const hitBudget = goal.status === "active"
    && goal.tokenBudget !== null
    && tokensUsed >= goal.tokenBudget;

  return {
    ...goal,
    tokensUsed,
    timeUsedMs,
    status: hitBudget ? "budget_limited" : goal.status,
    updatedAt: now,
  };
}

export function recordRunTools(goal: GoalState, hadToolCall: boolean, now = Date.now()): GoalState {
  if (goal.status !== "active") return goal;
  return {
    ...goal,
    noToolTurns: hadToolCall ? 0 : goal.noToolTurns + 1,
    updatedAt: now,
  };
}

export function reportGoalProgress(
  goal: GoalState,
  checks: readonly GoalCheck[],
  summary?: string,
  now = Date.now(),
): GoalState {
  if (goal.status !== "active") throw new Error("Progress can be updated only while the goal is active.");
  return synchronizeGoalProgress(goal, checks, summary, now);
}

export function synchronizeGoalProgress(
  goal: GoalState,
  checks: readonly GoalCheck[],
  summary?: string,
  now = Date.now(),
): GoalState {
  return {
    ...goal,
    checks: validateGoalChecks(checks),
    progressSummary: summary?.trim() || undefined,
    updatedAt: now,
  };
}

export function recordGoalBlocker(
  goal: GoalState,
  input: BlockerInput,
  turn: number,
  now = Date.now(),
): BlockerOutcome {
  if (goal.status !== "active") throw new Error("A blocker can be reported only while the goal is active.");
  const description = input.description.trim();
  if (!description) throw new Error("A blocked update requires a concrete blocker description.");
  const evidence = input.evidence?.trim() || undefined;
  const nextInput = input.nextInput?.trim() || undefined;
  const fingerprint = blockerFingerprint(description, nextInput);
  const previous = goal.blockerAudit;

  if (previous?.lastReportedTurn === turn) {
    return { goal, duplicate: true, blocked: false };
  }

  const count = previous?.fingerprint === fingerprint ? previous.count + 1 : 1;
  const blocked = count >= BLOCKED_AUDIT_TURNS;
  const blockerAudit: GoalBlockerAudit = {
    fingerprint,
    description,
    evidence,
    nextInput,
    count,
    lastReportedTurn: turn,
  };
  return {
    duplicate: false,
    blocked,
    goal: {
      ...goal,
      status: blocked ? "blocked" : goal.status,
      blockerAudit,
      updatedAt: now,
    },
  };
}

export function clearGoalBlockerAudit(goal: GoalState, now = Date.now()): GoalState {
  if (!goal.blockerAudit) return goal;
  return { ...goal, blockerAudit: undefined, updatedAt: now };
}

export function goalChecksComplete(goal: GoalState): boolean {
  return goal.checks.every((check) => check.status === "complete" || check.status === "cancelled");
}

export function goalCheckProgress(goal: GoalState): { complete: number; total: number } {
  return {
    complete: goal.checks.filter((check) => check.status === "complete" || check.status === "cancelled").length,
    total: goal.checks.length,
  };
}

export function currentGoalCheck(goal: GoalState): GoalCheck | undefined {
  return goal.checks.find((check) => check.status === "in_progress")
    ?? goal.checks.find((check) => check.status === "pending")
    ?? goal.checks.filter((check) => check.status === "complete").at(-1);
}

export function editGoalObjective(goal: GoalState, objective: string, now = Date.now()): GoalState {
  const status = goal.status === "complete" ? "active" : goal.status;
  const budgetExhausted = goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget;
  return {
    ...goal,
    objective: validateObjective(objective),
    status: status === "active" && budgetExhausted ? "budget_limited" : status,
    runTurns: 0,
    noToolTurns: 0,
    stallReason: undefined,
    blockerAudit: undefined,
    updatedAt: now,
  };
}

export function setGoalStatus(goal: GoalState, status: GoalStatus, now = Date.now()): GoalState {
  const resuming = status === "active" && goal.status !== "active";
  const budgetExhausted = goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget;
  const nextStatus = status === "active" && budgetExhausted ? "budget_limited" : status;
  return {
    ...goal,
    status: nextStatus,
    runTurns: resuming ? 0 : goal.runTurns,
    noToolTurns: resuming ? 0 : goal.noToolTurns,
    stallReason: resuming || nextStatus === "complete" ? undefined : goal.stallReason,
    blockerAudit: resuming || nextStatus === "complete" ? undefined : goal.blockerAudit,
    updatedAt: now,
  };
}

export function stallGoal(goal: GoalState, reason: string, now = Date.now()): GoalState {
  if (goal.status !== "active") return goal;
  const stallReason = reason.trim();
  if (!stallReason) throw new Error("A stalled goal requires a reason.");
  return {
    ...goal,
    status: "stalled",
    stallReason,
    blockerAudit: undefined,
    updatedAt: now,
  };
}

export function shouldConfirmReplacement(goal: GoalState | undefined): boolean {
  return goal !== undefined && goal.status !== "complete";
}

export function decodeGoalEntry(value: unknown): GoalEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { version?: unknown; goal?: unknown };
  if (entry.version !== 1 && entry.version !== 2) return undefined;
  if (entry.goal === null) return { version: 2, goal: null };
  const goal = decodeGoal(entry.goal);
  return goal ? { version: 2, goal } : undefined;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ${remainingMinutes}m`;
}

export function formatTokens(tokens: number): string {
  const normalized = Math.max(0, Math.round(tokens));
  if (normalized < 1_000) return String(normalized);
  if (normalized < 1_000_000) return `${trimDecimal(normalized / 1_000)}K`;
  if (normalized < 1_000_000_000) return `${trimDecimal(normalized / 1_000_000)}M`;
  return `${trimDecimal(normalized / 1_000_000_000)}B`;
}

function normalizeCounter(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function blockerFingerprint(description: string, nextInput: string | undefined): string {
  return `${normalizeText(description)}\n${normalizeText(nextInput ?? "")}`;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function decodeGoal(value: unknown): GoalState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const goal = value as Partial<Record<keyof GoalState | "blocker", unknown>>;
  if (
    typeof goal.id !== "string"
    || typeof goal.objective !== "string"
    || !isGoalStatus(goal.status)
    || !(goal.tokenBudget === null || typeof goal.tokenBudget === "number")
  ) return undefined;

  try {
    const checks = Array.isArray(goal.checks)
      ? validateGoalChecks(goal.checks as GoalCheck[])
      : [];
    const blockerAudit = decodeBlockerAudit(goal.blockerAudit)
      ?? (typeof goal.blocker === "string"
        ? {
            fingerprint: normalizeText(goal.blocker),
            description: goal.blocker,
            count: BLOCKED_AUDIT_TURNS,
            lastReportedTurn: validCounter(goal.turns),
          }
        : undefined);
    const legacyNoToolStall = goal.status === "blocked"
      && blockerAudit?.description === `${NO_TOOL_TURN_LIMIT} consecutive continuation runs made no tool calls.`;
    return {
      id: goal.id,
      objective: validateObjective(goal.objective),
      status: legacyNoToolStall ? "stalled" : goal.status,
      checks,
      progressSummary: typeof goal.progressSummary === "string" ? goal.progressSummary : undefined,
      stallReason: legacyNoToolStall
        ? `Automatic continuation paused after ${NO_TOOL_TURN_LIMIT} runs made no tool call or terminal goal update.`
        : typeof goal.stallReason === "string" ? goal.stallReason : undefined,
      blockerAudit: legacyNoToolStall ? undefined : blockerAudit,
      tokenBudget: validateTokenBudget(goal.tokenBudget),
      tokensUsed: validCounter(goal.tokensUsed),
      timeUsedMs: validCounter(goal.timeUsedMs),
      turns: validCounter(goal.turns),
      runTurns: validCounter(goal.runTurns),
      continuations: validCounter(goal.continuations),
      noToolTurns: validCounter(goal.noToolTurns),
      createdAt: validTimestamp(goal.createdAt),
      updatedAt: validTimestamp(goal.updatedAt),
    };
  } catch {
    return undefined;
  }
}

function decodeBlockerAudit(value: unknown): GoalBlockerAudit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const audit = value as Partial<Record<keyof GoalBlockerAudit, unknown>>;
  if (
    typeof audit.fingerprint !== "string"
    || typeof audit.description !== "string"
    || typeof audit.count !== "number"
    || typeof audit.lastReportedTurn !== "number"
  ) return undefined;
  return {
    fingerprint: audit.fingerprint,
    description: audit.description,
    evidence: typeof audit.evidence === "string" ? audit.evidence : undefined,
    nextInput: typeof audit.nextInput === "string" ? audit.nextInput : undefined,
    count: validCounter(audit.count),
    lastReportedTurn: validCounter(audit.lastReportedTurn),
  };
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active"
    || value === "paused"
    || value === "stalled"
    || value === "blocked"
    || value === "usage_limited"
    || value === "budget_limited"
    || value === "complete";
}

function isGoalCheckStatus(value: unknown): value is GoalCheckStatus {
  return value === "pending" || value === "in_progress" || value === "complete" || value === "cancelled";
}

function validCounter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error();
  return value;
}

function validTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error();
  return value;
}
