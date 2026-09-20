import { entryUsage } from "../footer/usage.ts";
import { SUBAGENT_USAGE_ENTRY_TYPE } from "../subagents/usage.ts";

const METRICS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const;
type Metric = typeof METRICS[number];
export interface UsageRow {
  entryId: string | null;
  timestamp: string | null;
  source: string;
  provider: string | null;
  model: string | null;
  stopReason: string | null;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  totalTokens: number | null;
  cost: number | null;
}
export interface UsageReport {
  version: 1;
  scope: "branch" | "session";
  generatedAt: string;
  rows: UsageRow[];
  totals: Record<Metric, { known: number; missing: number }>;
}
const numeric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown): string | null => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 256) : null;

/** Allowlist metadata rather than serializing message/session objects. */
export function buildReport(entries: Iterable<unknown>, scope: UsageReport["scope"], now = new Date()): UsageReport {
  const rows: UsageRow[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, any>;
    const assistant = entry.type === "message" && entry.message?.role === "assistant";
    const child = entry.type === "custom" && entry.customType === SUBAGENT_USAGE_ENTRY_TYPE
      && entry.data?.version === 1 && typeof entry.data.agentId === "string"
      && typeof entry.data.agentName === "string" && entry.data.usage && typeof entry.data.usage === "object"
      ? entry.data : undefined;
    const usage = (child ? { ...child.usage, cost: { total: child.usage.cost } } : entryUsage(entry)) as Record<string, any> | undefined;
    // Keep assistant responses even if the provider omitted usage. Other entry
    // kinds contribute only when Pi explicitly records nested/summary usage.
    if (!assistant && !usage) continue;
    const id = text(entry.id);
    const identity = typeof entry.id === "string" ? entry.id : undefined;
    if (identity && seen.has(identity)) continue;
    if (identity) seen.add(identity);
    const message = assistant ? entry.message : child;
    rows.push({
      entryId: id, timestamp: text(entry.timestamp),
      source: child ? "subagent" : entry.type === "message" ? (assistant ? "assistant" : "toolResult") : entry.type,
      provider: text(message?.provider), model: text(message?.model), stopReason: text(message?.stopReason),
      input: numeric(usage?.input), output: numeric(usage?.output),
      cacheRead: numeric(usage?.cacheRead), cacheWrite: numeric(usage?.cacheWrite),
      totalTokens: numeric(usage?.totalTokens), cost: numeric(usage?.cost?.total),
    });
  }
  const totals = Object.fromEntries(METRICS.map((key) => [key, {
    known: rows.reduce((sum, row) => sum + (row[key] ?? 0), 0),
    missing: rows.filter((row) => row[key] === null).length,
  }])) as UsageReport["totals"];
  return { version: 1, scope, generatedAt: now.toISOString(), rows, totals };
}

/** Quoted cells plus formula-prefix neutralization for spreadsheet consumers. */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const safe = /^[\s]*[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function formatReport(report: UsageReport, format: "json" | "csv"): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  const columns: (keyof UsageRow)[] = ["entryId", "timestamp", "source", "provider", "model", "stopReason", ...METRICS];
  return [columns.join(","), ...report.rows.map((row) => columns.map((key) => csvCell(row[key])).join(","))].join("\n") + "\n";
}
