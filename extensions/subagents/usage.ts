export const SUBAGENT_USAGE_ENTRY_TYPE = "subagent-usage";
/** Invalidates readers of the current branch; carries no cross-session totals. */
export const SUBAGENT_USAGE_EVENT = "subagent:usage-recorded";

export interface RecordedSubagentUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

export interface SubagentUsageRecord {
  version: 1;
  agentId: string;
  agentName: string;
  provider?: string;
  model?: string;
  usage: RecordedSubagentUsage;
}

export function usageRecord(message: unknown, agent: { id: string; name: string }): SubagentUsageRecord | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") return undefined;
  return {
    version: 1,
    agentId: agent.id,
    agentName: agent.name,
    provider: typeof record.provider === "string" ? record.provider : undefined,
    model: typeof record.model === "string" ? record.model : undefined,
    usage: normalizeUsage(record.usage),
  };
}

export function decodeUsageRecord(value: unknown): SubagentUsageRecord | undefined {
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

function normalizeUsage(value: any): RecordedSubagentUsage {
  return {
    input: nonNegative(value?.input),
    output: nonNegative(value?.output),
    cacheRead: nonNegative(value?.cacheRead),
    cacheWrite: nonNegative(value?.cacheWrite),
    cost: nonNegative(value?.cost?.total ?? value?.cost),
  };
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
