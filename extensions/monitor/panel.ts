import type { TranscriptBlock } from "../../lib/transcript/model.ts";
import { plainText } from "../../lib/transcript/model.ts";
import { formatDuration } from "../loop/interval.ts";
import type { MonitorJob } from "./monitor.ts";

export function monitorBlocks(jobs: readonly MonitorJob[]): TranscriptBlock[] {
  return [{ id: "monitors", label: "Command monitors", kind: "custom", body: [
    "Snapshot · /monitor pause|resume|stop <id> to manage monitors. Reopen to refresh.",
    jobs.length ? `${jobs.length} retained monitors` : "No monitors are configured.",
    "Checks run only while the session is idle. Command output is not retained in this view.",
  ].join("\n\n") }, ...jobs.slice().sort((a, b) => b.createdAt - a.createdAt).map((job): TranscriptBlock => ({
    id: job.id, label: `${job.id} · ${job.status}`, kind: "custom",
    body: plainText([
      `Every ${formatDuration(job.intervalMs)} · wake on ${job.condition}`,
      `Checks: ${job.runs}/${job.maxRuns} · ${Math.max(0, job.maxRuns - job.runs)} remaining`,
      job.nextRunAt === null ? "No check armed" : `Next check: ${new Date(job.nextRunAt).toISOString()}`,
      `Expires: ${new Date(job.expiresAt).toISOString()}`,
      job.lastRunAt === undefined ? "No previous check" : `Last check: ${new Date(job.lastRunAt).toISOString()}`,
      job.lastExitCode === undefined ? "Exit status unknown" : `Last exit: ${job.lastExitCode}`,
      job.lastWakeReason ? `Last wake: ${job.lastWakeReason}` : "",
      job.pendingFinalAlert ? `Final alert pending: ${job.pendingFinalAlert.limitReason}` : "",
      job.finalRetryReason ? `Retry: ${job.finalRetryReason}` : "",
      job.stopReason ? `Reason: ${job.stopReason}` : "",
      `Command:\n${job.command}`,
    ].filter(Boolean).join("\n\n")),
  }))];
}
