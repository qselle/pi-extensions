import type { UsageTotals } from "./format.ts";
import { decodeUsageRecord, SUBAGENT_USAGE_ENTRY_TYPE } from "../subagents/usage.ts";

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/** Include parent calls and persisted child response deltas, never child snapshots. */
export function entryUsage(entry: unknown): UsageLike | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const candidate = entry as { type?: string; customType?: string; data?: unknown; message?: { role?: string; usage?: UsageLike }; usage?: UsageLike };
  if (candidate.type === "custom" && candidate.customType === SUBAGENT_USAGE_ENTRY_TYPE) {
    const record = decodeUsageRecord(candidate.data);
    return record ? { ...record.usage, cost: { total: record.usage.cost } } : undefined;
  }
  if (candidate.type === "message") {
    const role = candidate.message?.role;
    return role === "assistant" || role === "toolResult" ? candidate.message?.usage : undefined;
  }
  if (candidate.type === "branch_summary" || candidate.type === "compaction" || candidate.type === "usage") return candidate.usage;
  return undefined;
}

export function sumUsage(entries: Iterable<unknown>): UsageTotals {
  const fields = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
  const known = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const missing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const seenIds = new Set<string>();
  const seenEntries = new WeakSet<object>();
  let responses = 0;
  for (const entry of entries) {
    const usage = entryUsage(entry);
    // An assistant or standalone usage entry represents a model call even when
    // its usage is missing. Ordinary tools and custom summaries need not call a model.
    if (!usage && !expectsUsage(entry)) continue;
    // The same append-only entry can be shared by branch projections. Deduplicate
    // identity only: equal usage from two distinct child responses is real work.
    if (entry && typeof entry === "object") {
      const id = (entry as { id?: unknown }).id;
      if (seenEntries.has(entry) || typeof id === "string" && id !== "" && seenIds.has(id)) continue;
      seenEntries.add(entry);
      if (typeof id === "string" && id !== "") seenIds.add(id);
    }
    responses++;
    for (const field of fields) {
      const value = field === "cost" ? usage?.cost?.total : usage?.[field];
      if (validUsageNumber(value)) known[field] += value;
      else missing[field]++;
    }
  }
  return { ...known, responses, missing };
}

function expectsUsage(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as { type?: string; message?: { role?: string } };
  return candidate.type === "usage" || candidate.type === "message" && candidate.message?.role === "assistant";
}

function validUsageNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Cache branch totals between usage events to avoid a full scan on every keystroke. */
export class UsageTotalsCache {
  private totals?: UsageTotals;
  private revision?: string | null;

  get(entries: () => Iterable<unknown>, revision?: string | null): UsageTotals {
    // Cache warming appends usage outside the ordinary assistant lifecycle.
    if (this.revision !== revision) this.invalidate();
    this.revision = revision;
    return (this.totals ??= sumUsage(entries()));
  }

  invalidate(): void {
    this.totals = undefined;
  }
}
