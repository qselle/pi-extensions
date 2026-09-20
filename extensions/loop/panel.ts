import type { TranscriptBlock } from "../../lib/transcript/model.ts";
import { plainText } from "../../lib/transcript/model.ts";
import type { DefaultLoopPrompt } from "./defaults.ts";
import { formatDuration } from "./interval.ts";
import type { LoopJob } from "./loop.ts";

interface LoopViewState {
  runningId?: string;
  pendingId?: string;
  defaultPrompt?: DefaultLoopPrompt;
}

function timestamp(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "unavailable";
}

/** A read-only snapshot: viewing never arms, expires, or reschedules a loop. */
export function loopBlocks(jobs: readonly LoopJob[], state: LoopViewState = {}): TranscriptBlock[] {
  const count = (status: LoopJob["status"]) => jobs.filter((job) => job.status === status).length;
  const rank = { active: 0, paused: 1, stopped: 2, expired: 3 };
  return [{ id: "overview", label: "Session loops", kind: "custom", body: [
    jobs.length ? `${count("active")} active · ${count("paused")} paused · ${count("stopped") + count("expired")} finished` : "No loops are scheduled.",
    "Snapshot · /loop pause|resume|stop <id> to manage loops. Reopen to refresh.",
    "Wakeups wait for an idle session; nothing runs while Pi is closed.",
  ].join("\n\n") }, ...jobs.slice().sort((a, b) => rank[a.status] - rank[b.status] || b.createdAt - a.createdAt).map((job): TranscriptBlock => {
    const currentDefault = job.promptSource === "default" && (job.status === "active" || job.status === "paused") ? state.defaultPrompt : undefined;
    const source = currentDefault
      ? `Current default prompt: ${currentDefault.source}. Re-read at each wake; an already running iteration keeps its supplied prompt.`
      : job.promptSource === "default" ? "Default prompt recorded when this loop was created." : "Explicit prompt";
    return {
      id: `loop:${job.id}`, label: `${job.id} · ${job.status}`, kind: "custom",
      ...(job.status === "paused" ? { labelColor: "warning" as const } : job.status === "stopped" || job.status === "expired" ? { labelColor: "muted" as const } : {}),
      body: plainText([
        job.mode === "dynamic" ? "Model-paced · loop_schedule chooses a delay from 1m to 1h" : `Fixed cadence · every ${formatDuration(job.intervalMs!)}`,
        `Iterations: ${job.iterations}/${job.maxIterations} · ${Math.max(0, job.maxIterations - job.iterations)} remaining`,
        state.runningId === job.id ? "Iteration running" : state.pendingId === job.id ? "Wake queued; iteration has not started" : "No iteration pending or running",
        job.nextRunAt === null ? "No wake armed" : `Next wake: ${timestamp(job.nextRunAt)}`,
        `Expires: ${timestamp(job.expiresAt)}`,
        job.lastScheduleReason ? `Pacing reason: ${job.lastScheduleReason}` : "",
        job.fallbackWakeups ? "One automatic fallback has been used; another missing schedule stops the loop." : "",
        job.stopReason ? `Reason: ${job.stopReason}` : "",
        `${source}\n\n${currentDefault?.prompt ?? job.prompt}`,
      ].filter(Boolean).join("\n\n")),
    };
  })];
}
