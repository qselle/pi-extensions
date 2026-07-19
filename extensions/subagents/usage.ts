export const SUBAGENT_USAGE_ENTRY_TYPE = "subagent-usage";

export interface SubagentUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SubagentUsageRecord {
  version: 1;
  agentId: string;
  agentName: string;
  provider?: string;
  model?: string;
  usage: SubagentUsageTotals;
}

export function emptySubagentUsage(): SubagentUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function usageRecord(message: any, agent: { id: string; name: string }): SubagentUsageRecord | undefined {
  if (!message?.usage) return undefined;
  return {
    version: 1,
    agentId: agent.id,
    agentName: agent.name,
    provider: typeof message.provider === "string" ? message.provider : undefined,
    model: typeof message.model === "string" ? message.model : undefined,
    usage: normalizeUsage(message.usage),
  };
}

export function addSubagentUsage(
  left: SubagentUsageTotals,
  right: SubagentUsageTotals,
): SubagentUsageTotals {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cost: left.cost + right.cost,
  };
}

export function restoreSubagentUsage(entries: readonly unknown[]): SubagentUsageTotals {
  let total = emptySubagentUsage();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (candidate.type !== "custom" || candidate.customType !== SUBAGENT_USAGE_ENTRY_TYPE) continue;
    const record = decodeUsageRecord(candidate.data);
    if (record) total = addSubagentUsage(total, record.usage);
  }
  return total;
}

export function formatSubagentUsage(total: SubagentUsageTotals): string | undefined {
  if (!total.input && !total.output && !total.cacheRead && !total.cacheWrite && !total.cost) return undefined;
  const parts = [
    total.input ? `↑${formatTokens(total.input)}` : "",
    total.output ? `↓${formatTokens(total.output)}` : "",
    total.cacheRead ? `R${formatTokens(total.cacheRead)}` : "",
    total.cacheWrite ? `W${formatTokens(total.cacheWrite)}` : "",
    total.cost ? `$${total.cost.toFixed(4)}` : "",
  ].filter(Boolean);
  return `agents ${parts.join(" ")}`;
}

function decodeUsageRecord(value: unknown): SubagentUsageRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<SubagentUsageRecord>;
  if (candidate.version !== 1 || typeof candidate.agentId !== "string" || typeof candidate.agentName !== "string") return undefined;
  return {
    version: 1,
    agentId: candidate.agentId,
    agentName: candidate.agentName,
    provider: typeof candidate.provider === "string" ? candidate.provider : undefined,
    model: typeof candidate.model === "string" ? candidate.model : undefined,
    usage: normalizeUsage(candidate.usage),
  };
}

function normalizeUsage(value: any): SubagentUsageTotals {
  return {
    input: nonNegative(value?.input),
    output: nonNegative(value?.output),
    cacheRead: nonNegative(value?.cacheRead),
    cacheWrite: nonNegative(value?.cacheWrite),
    cost: nonNegative(value?.cost?.total ?? value?.cost),
  };
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
