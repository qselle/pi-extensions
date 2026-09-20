export const MAX_PLAN_ITEMS = 10;
export const MAX_PLAN_NODES = 40;
export const MAX_PLAN_DEPTH = 3;
export const MAX_PLAN_STEP_CHARS = 240;
export const MAX_PLAN_EXPLANATION_CHARS = 600;

export type PlanItemStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface PlanItem {
  step: string;
  status: PlanItemStatus;
  children?: PlanItem[];
}

export interface PlanItemInput {
  step: string;
  status?: PlanItemStatus;
  children?: PlanItemInput[];
}

export interface PlanState {
  items: PlanItem[];
  explanation?: string;
  updatedAt: number;
}

export interface PlanEntry {
  version: 1 | 2;
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
  items: readonly PlanItemInput[],
  explanation?: string,
  now = Date.now(),
): PlanState {
  return {
    items: validatePlanItems(items),
    explanation: validateExplanation(explanation),
    updatedAt: now,
  };
}

export function validatePlanItems(items: readonly PlanItemInput[]): PlanItem[] {
  let count = 0;
  const normalize = (nodes: readonly PlanItemInput[], depth: number): PlanItem[] => {
    if (!Array.isArray(nodes) || nodes.length > MAX_PLAN_ITEMS) throw new Error(`A plan group can have at most ${MAX_PLAN_ITEMS} steps.`);
    if (depth > MAX_PLAN_DEPTH) throw new Error(`Plans support at most ${MAX_PLAN_DEPTH} levels.`);
    const seen = new Set<string>();
    return nodes.map((item, index) => {
      if (++count > MAX_PLAN_NODES) throw new Error(`A plan can contain at most ${MAX_PLAN_NODES} groups and steps combined.`);
      if (!item || typeof item.step !== "string") throw new Error("Each plan item needs a step.");
      const step = item.step.trim().replace(/\s+/g, " ");
      if (!step) throw new Error(`Plan step ${index + 1} must not be empty.`);
      if ([...step].length > MAX_PLAN_STEP_CHARS) throw new Error(`Plan steps must be at most ${MAX_PLAN_STEP_CHARS} characters.`);
      const fingerprint = step.toLowerCase();
      if (seen.has(fingerprint)) throw new Error(`Duplicate plan step: ${step}`);
      seen.add(fingerprint);
      if (item.children !== undefined) {
        if (!Array.isArray(item.children) || !item.children.length) throw new Error("Plan groups need at least one child step.");
        const children = normalize(item.children, depth + 1);
        const stats = planStats(children);
        const status: PlanItemStatus = stats.cancelled === stats.total ? "cancelled" : stats.finished === stats.total ? "completed" : stats.inProgress ? "in_progress" : "pending";
        return { step, status, children };
      }
      if (!isPlanItemStatus(item.status)) throw new Error(`Unknown plan status for step ${index + 1}: ${String(item.status)}`);
      return { step, status: item.status };
    });
  };
  const normalized = normalize(items, 1);
  const stats = planStats(normalized);
  if (stats.inProgress > 1) throw new Error("Only one plan step may be in progress.");
  if (stats.unfinished > 0 && stats.inProgress !== 1) throw new Error("An unfinished plan must have exactly one in-progress step.");
  return normalized;
}

export interface PlanRow { item: PlanItem; depth: number; path: string }
export function planRows(items: readonly PlanItem[], collapsed: ReadonlySet<string> = new Set(), depth = 0, parent = ""): PlanRow[] {
  return items.flatMap((item, index) => {
    const path = parent ? `${parent}.${index}` : String(index);
    return [{ item, depth, path }, ...(item.children && !collapsed.has(path) ? planRows(item.children, collapsed, depth + 1, path) : [])];
  });
}
export function planLeaves(items: readonly PlanItem[]): PlanItem[] {
  return items.flatMap((item) => item.children ? planLeaves(item.children) : [item]);
}

export function validateExplanation(explanation: string | undefined): string | undefined {
  const normalized = explanation?.trim().replace(/\s+/g, " ") || undefined;
  if (normalized && [...normalized].length > MAX_PLAN_EXPLANATION_CHARS) {
    throw new Error(`Plan explanations must be at most ${MAX_PLAN_EXPLANATION_CHARS} characters.`);
  }
  return normalized;
}

export function planStats(nodes: readonly PlanItem[]): PlanStats {
  const items = planLeaves(nodes);
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
  const items = planLeaves(plan.items);
  return items.find((item) => item.status === "in_progress")
    ?? items.find((item) => item.status === "pending")
    ?? items.filter((item) => item.status === "completed").at(-1)
    ?? items.at(-1);
}

export function planIsActive(plan: PlanState): boolean {
  const stats = planStats(plan.items);
  return stats.total > 0 && stats.unfinished > 0;
}

export function decodePlanEntry(value: unknown): PlanEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { version?: unknown; plan?: unknown };
  if (entry.version !== 1 && entry.version !== 2) return undefined;
  const plan = decodePlanState(entry.plan);
  return plan ? { version: entry.version, plan } : undefined;
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
