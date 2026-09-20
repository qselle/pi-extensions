import type { SavedAgent } from "./coordinator.ts";
export const SUBAGENT_STATE = "subagents-state";

/** Session entries are data, not authority to start processes or open arbitrary files. */
export function restoreAgents(entries: readonly any[]): SavedAgent[] {
  const entry = [...entries].reverse().find((row) => row?.type === "custom" && row.customType === SUBAGENT_STATE);
  if (entry?.data?.version !== 1 || !Array.isArray(entry.data.agents)) return [];
  const names = new Set<string>();
  return entry.data.agents.slice(0, 16).flatMap((row: any) => {
    const a = row?.agent, r = row?.resume;
    if (!a || typeof a.id !== "string" || a.id.length > 100 || typeof a.name !== "string" || !a.name.trim() || a.name.length > 64 || names.has(a.name.toLowerCase())
      || typeof a.task !== "string" || a.task.length > 16000 || typeof a.cwd !== "string" || a.cwd.length > 4096
      || !["fresh", "summary", "fork"].includes(a.contextMode) || !["starting", "running", "completed", "failed", "stopped"].includes(a.status)
      || !Number.isFinite(a.startedAt) || typeof a.output !== "string" || a.output.length > 32768
      || (a.error !== undefined && (typeof a.error !== "string" || a.error.length > 8192))
      || (a.model !== undefined && (typeof a.model !== "string" || a.model.length > 300))
      || (a.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(a.thinking))
      || !a.usage || ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"].some((key) => !Number.isFinite(a.usage[key]) || a.usage[key] < 0)
      || !Array.isArray(row.inbox) || row.inbox.length > 8 || row.inbox.some((message: unknown) => typeof message !== "string" || message.length > 16000)) return [];
    if (r && (typeof r.directory !== "string" || !/^pi-subagent-context-[\w-]+$/.test(r.directory) || typeof r.file !== "string" || !/^[\w.-]+\.jsonl$/.test(r.file)
      || !Number.isSafeInteger(r.initialEntryCount) || r.initialEntryCount < 0 || !(r.leafId === null || typeof r.leafId === "string" && /^[\w-]{1,100}$/.test(r.leafId)))) return [];
    names.add(a.name.toLowerCase());
    const matches = (value: any) => value?.id === a.id && value?.endedAt === a.endedAt;
    const delivered = entries.some((entry) => entry?.type === "custom_message" && entry.customType === "subagent-completion" && matches(entry.details)
      || entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagents" && ["wait", "read"].includes(entry.message.details?.action) && entry.message.details?.agents?.some(matches));
    return [{ agent: { ...a, activity: Array.isArray(a.activity) ? a.activity.filter((s: unknown) => typeof s === "string").slice(-12).map((s: string) => s.slice(0, 200)) : [] }, resume: r,
      delivery: delivered ? "wait" : "none", inbox: [...row.inbox] } satisfies SavedAgent];
  });
}
