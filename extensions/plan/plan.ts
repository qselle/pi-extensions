export const MAX_PLAN_ITEMS = 10;
export const MAX_PLAN_STEP_CHARS = 240;
export const MAX_PLAN_EXPLANATION_CHARS = 600;

export type PlanItemStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface PlanItem {
  step: string;
  status: PlanItemStatus;
}

export interface PlanState {
  items: PlanItem[];
  explanation?: string;
  updatedAt: number;
}

export interface PlanEntry {
  version: 1;
  plan: PlanState;
}

export interface PlanStats {
  completed: number;
  cancelled: number;
  finished: number;
  inProgress: number;
  pending: number;
  unfinished: number;
  total: number;
}

export function createPlanState(now = Date.now()): PlanState {
  return { items: [], updatedAt: now };
}

export function replacePlan(
  _current: PlanState,
  items: readonly PlanItem[],
  explanation?: string,
  now = Date.now(),
): PlanState {
  return {
    items: validatePlanItems(items),
    explanation: validateExplanation(explanation),
    updatedAt: now,
  };
}

export function validatePlanItems(items: readonly PlanItem[]): PlanItem[] {
  if (items.length > MAX_PLAN_ITEMS) {
    throw new Error(`A plan can have at most ${MAX_PLAN_ITEMS} steps.`);
  }

  const seen = new Set<string>();
  const normalized = items.map((item, index) => {
    const step = item.step.trim().replace(/\s+/g, " ");
    if (!step) throw new Error(`Plan step ${index + 1} must not be empty.`);
    if ([...step].length > MAX_PLAN_STEP_CHARS) {
      throw new Error(`Plan steps must be at most ${MAX_PLAN_STEP_CHARS} characters.`);
    }
    if (!isPlanItemStatus(item.status)) {
      throw new Error(`Unknown plan status for step ${index + 1}: ${String(item.status)}`);
    }
    const fingerprint = step.toLowerCase();
    if (seen.has(fingerprint)) throw new Error(`Duplicate plan step: ${step}`);
    seen.add(fingerprint);
    return { step, status: item.status };
  });

  const stats = planStats(normalized);
  if (stats.inProgress > 1) throw new Error("Only one plan step may be in progress.");
  if (stats.unfinished > 0 && stats.inProgress !== 1) {
    throw new Error("An unfinished plan must have exactly one in-progress step.");
  }
  return normalized;
}

export function validateExplanation(explanation: string | undefined): string | undefined {
  const normalized = explanation?.trim().replace(/\s+/g, " ") || undefined;
  if (normalized && [...normalized].length > MAX_PLAN_EXPLANATION_CHARS) {
    throw new Error(`Plan explanations must be at most ${MAX_PLAN_EXPLANATION_CHARS} characters.`);
  }
  return normalized;
}

export function planStats(items: readonly PlanItem[]): PlanStats {
  const completed = items.filter((item) => item.status === "completed").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const inProgress = items.filter((item) => item.status === "in_progress").length;
  const pending = items.filter((item) => item.status === "pending").length;
  const finished = completed + cancelled;
  return {
    completed,
    cancelled,
    finished,
    inProgress,
    pending,
    unfinished: items.length - finished,
    total: items.length,
  };
}

export function currentPlanItem(plan: PlanState): PlanItem | undefined {
  return plan.items.find((item) => item.status === "in_progress")
    ?? plan.items.find((item) => item.status === "pending")
    ?? plan.items.filter((item) => item.status === "completed").at(-1)
    ?? plan.items.at(-1);
}

export function planIsActive(plan: PlanState): boolean {
  const stats = planStats(plan.items);
  return stats.total > 0 && stats.unfinished > 0;
}

export function decodePlanEntry(value: unknown): PlanEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { version?: unknown; plan?: unknown };
  if (entry.version !== 1) return undefined;
  const plan = decodePlanState(entry.plan);
  return plan ? { version: 1, plan } : undefined;
}

export function planResponse(plan: PlanState): string {
  const stats = planStats(plan.items);
  return JSON.stringify({
    plan: {
      items: plan.items,
      explanation: plan.explanation ?? null,
      progress: {
        finished: stats.finished,
        completed: stats.completed,
        cancelled: stats.cancelled,
        total: stats.total,
      },
      active: stats.unfinished > 0,
      updatedAt: plan.updatedAt,
    },
  });
}

function decodePlanState(value: unknown): PlanState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { items?: unknown; explanation?: unknown; updatedAt?: unknown };
  if (!Array.isArray(raw.items)) return undefined;
  if (typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0) return undefined;

  try {
    return {
      items: validatePlanItems(raw.items as PlanItem[]),
      explanation: typeof raw.explanation === "string" ? validateExplanation(raw.explanation) : undefined,
      updatedAt: raw.updatedAt,
    };
  } catch {
    return undefined;
  }
}

function isPlanItemStatus(value: unknown): value is PlanItemStatus {
  return value === "pending"
    || value === "in_progress"
    || value === "completed"
    || value === "cancelled";
}
