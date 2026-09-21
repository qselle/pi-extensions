import type { UsageTotals } from "./format.ts";

interface UsageLike {
  input?: number;
  output?: number;
  cost?: { total?: number };
}

/** Include assistant, nested tool, summary, and compaction usage. */
export function entryUsage(entry: unknown): UsageLike | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const candidate = entry as { type?: string; message?: { role?: string; usage?: UsageLike }; usage?: UsageLike };
  if (candidate.type === "message") {
    const role = candidate.message?.role;
    return role === "assistant" || role === "toolResult" ? candidate.message?.usage : undefined;
  }
  if (candidate.type === "branch_summary" || candidate.type === "compaction" || candidate.type === "usage") return candidate.usage;
  return undefined;
}

export function sumUsage(entries: Iterable<unknown>): UsageTotals {
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const entry of entries) {
    const usage = entryUsage(entry);
    if (!usage) continue;
    input += usage.input ?? 0;
    output += usage.output ?? 0;
    cost += usage.cost?.total ?? 0;
  }
  return { input, output, cost };
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
