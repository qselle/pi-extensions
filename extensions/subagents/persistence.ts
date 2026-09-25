import type { SavedAgent } from "./coordinator.ts";
import { decodeParentReport, MAX_RETAINED_REPORTS, MAX_SEEN_REPORT_IDS, REPORT_MESSAGE_TYPE, type SavedReport } from "./report.ts";
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
      || !Number.isFinite(a.startedAt) || (a.createdAt !== undefined && !Number.isFinite(a.createdAt))
      || typeof a.output !== "string" || a.output.length > 32768
      || (a.error !== undefined && (typeof a.error !== "string" || a.error.length > 8192))
      || (a.model !== undefined && (typeof a.model !== "string" || a.model.length > 300))
      || (a.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(a.thinking))
      || (a.runId !== undefined && (typeof a.runId !== "string" || !a.runId || a.runId.length > 100))
      || !a.usage || ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"].some((key) => !Number.isFinite(a.usage[key]) || a.usage[key] < 0)
      || !Array.isArray(row.inbox) || row.inbox.length > 8 || row.inbox.some((message: unknown) => typeof message !== "string" || message.length > 16000)) return [];
    if (r && (typeof r.directory !== "string" || !/^pi-subagent-context-[\w-]+$/.test(r.directory) || typeof r.file !== "string" || !/^[\w.-]+\.jsonl$/.test(r.file)
      || !Number.isSafeInteger(r.initialEntryCount) || r.initialEntryCount < 0 || !(r.leafId === null || typeof r.leafId === "string" && /^[\w-]{1,100}$/.test(r.leafId)))) return [];
    names.add(a.name.toLowerCase());
    const matches = (value: any) => value?.id === a.id && ["completed", "failed"].includes(value?.status)
      && value?.endedAt === a.endedAt && (!a.runId || value?.runId === a.runId);
    const delivered = entries.some((entry) => entry?.type === "custom_message" && entry.customType === "subagent-completion" && matches(entry.details)
      || entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagents" && ["wait", "read"].includes(entry.message.details?.action) && entry.message.details?.agents?.some(matches));
    const seen = new Set<string>();
    const reports: SavedReport[] = (Array.isArray(row.reports) ? row.reports : []).slice(-MAX_RETAINED_REPORTS).flatMap((record: any) => {
      const report = decodeParentReport(record?.report);
      if (!report || seen.has(report.id) || typeof record.runId !== "string" || !record.runId || record.runId.length > 100) return [];
      seen.add(report.id);
      const consumed = entries.some((entry) => entry?.type === "custom_message" && entry.customType === REPORT_MESSAGE_TYPE
        && entry.details?.agentId === a.id && entry.details?.report?.id === report.id
        || entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagents"
        && ["read", "wait"].includes(entry.message.details?.action)
        && entry.message.details?.agents?.some((agent: any) => agent.id === a.id && agent.reports?.some((item: any) => item.id === report.id)));
      return [{ report, runId: record.runId, delivery: consumed ? "wait" : "none" } satisfies SavedReport];
    });
    const seenReportIds = [...new Set([...(Array.isArray(row.seenReportIds) ? row.seenReportIds : []).filter((id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 500), ...reports.map((record) => record.report.id)])].slice(-MAX_SEEN_REPORT_IDS) as string[];
    return [{ agent: { ...a, createdAt: a.createdAt ?? a.startedAt,
      omittedReports: Number.isSafeInteger(a.omittedReports) && a.omittedReports >= 0 ? a.omittedReports : 0,
      activity: Array.isArray(a.activity) ? a.activity.filter((s: unknown) => typeof s === "string").slice(-12).map((s: string) => s.slice(0, 200)) : [] }, resume: r,
      delivery: delivered ? "wait" : "none", inbox: [...row.inbox], reports, seenReportIds } satisfies SavedAgent];
  });
}
