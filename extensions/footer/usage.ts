/**
 * Branch usage accounting for the footer.
 *
 * Deliberately free of pi-tui imports so it stays trivially unit-testable, and
 * separate from `format.ts` because this part reads session entries rather than
 * formatting strings.
 */

import type { UsageTotals } from "./format.ts";

interface UsageLike {
  input?: number;
  output?: number;
  cost?: { total?: number };
}

/**
 * Usage attributable to a single session entry.
 *
 * Mirrors pi's built-in footer, which counts assistant usage, tool-result usage
 * (nested model calls made by tools such as subagents or side-chat), and the
 * usage recorded on branch summaries and compactions.
 */
export function entryUsage(entry: unknown): UsageLike | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const candidate = entry as { type?: string; message?: { role?: string; usage?: UsageLike }; usage?: UsageLike };
  if (candidate.type === "message") {
    const role = candidate.message?.role;
    return role === "assistant" || role === "toolResult" ? candidate.message?.usage : undefined;
  }
  if (candidate.type === "branch_summary" || candidate.type === "compaction") return candidate.usage;
  return undefined;
}

/** Cumulative tokens and cost for the given entries. */
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

/**
 * Totals cache for the render path.
 *
 * The footer re-renders on every keystroke, so scanning the branch per frame
 * would be O(entries) per frame. Totals only change when new usage is recorded
 * or the branch is rewritten, so the extension invalidates on those events and
 * the scan happens at most once per change.
 */
export class UsageTotalsCache {
  private totals?: UsageTotals;

  get(entries: () => Iterable<unknown>): UsageTotals {
    return (this.totals ??= sumUsage(entries()));
  }

  invalidate(): void {
    this.totals = undefined;
  }
}
