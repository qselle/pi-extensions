import type { GoalAttentionEvent, GoalCompletedEvent } from "../goal/events.ts";
import type { ScheduleAttentionEvent } from "../schedule/events.ts";
import type { GoalCheck } from "../goal/goal.ts";
import type { TelegramGoalDetails } from "./config.ts";
import type { MonitorAlertEvent } from "../monitor/events.ts";

export const TELEGRAM_MESSAGE_LIMIT = 3_500;

export function formatMonitorAlertMessage(event: MonitorAlertEvent): string {
  if (event.kind === "expired") {
    const limit = event.reason === "run_limit" ? `its ${event.maxRuns}-check limit` : "its 12-hour lifetime";
    return `⚠️ Pi monitoring ended\n\nMonitor ${event.monitorId} · ${event.runs}/${event.maxRuns} checks\nMonitoring reached ${limit} without another actionable result.\n\nNo further checks are scheduled. Open Pi to start a new monitor if needed.`;
  }
  const title = event.kind === "result" ? "🔎 Pi monitor update" : "⚠️ Pi monitor needs attention";
  const result = event.killed ? "Check timed out or was killed" : `Exit ${event.exitCode}`;
  const condition = { change: "Result changed", failure: "Failure detected", success: "Success detected", always: "Scheduled check" }[event.condition];
  const next = event.kind === "wakeup_failed"
    ? "Monitoring paused: Pi could not start the alert turn. Open the session to resume."
    : event.kind === "agent_failed"
      ? "Monitoring paused: Pi could not finish reviewing the result. Open the session to resume."
      : "Pi has been asked to review the result. Questions can also reach this chat.";
  return `${title}\n\nMonitor ${event.monitorId} · check ${event.runs}/${event.maxRuns}\n${condition} · ${result}\n\n${next}`;
}

export function formatGoalAttentionMessage(event: GoalAttentionEvent): string {
  const status = {
    blocked: "Goal blocked",
    stalled: "Goal stalled",
    budget_limited: "Goal budget reached",
    usage_limited: "Goal waiting for provider capacity",
  }[event.status];
  const next = {
    blocked: "Progress needs your input or an external change. Open Pi to review the blocker; any pending questionnaire can also reach this chat.",
    stalled: "Automatic progress has stopped. Open Pi to inspect the issue and resume when ready.",
    budget_limited: "The goal's token budget is exhausted. Open Pi to review progress before starting further work.",
    usage_limited: "The provider cannot continue right now. Resume the goal in Pi when capacity is available.",
  }[event.status];
  return `⚠️ Pi needs attention\n\n${status} · ${event.turns} turn${event.turns === 1 ? "" : "s"}\nTokens: ${formatTokens(event.tokensUsed)}${event.tokenBudget === null ? "" : ` / ${formatTokens(event.tokenBudget)}`}\n\n${next}`;
}

export function formatScheduleAttentionMessage(event: ScheduleAttentionEvent): string {
  const reason = {
    queue_failed: "Scheduled work cannot continue because its durable queue could not be read or saved.",
    wakeup_failed: "The scheduled task paused because Pi could not start its turn.",
    agent_failed: "The scheduled task paused because its agent turn failed. Its pending delivery is preserved.",
    delivery_unconfirmed: "The turn finished, but its completion could not be saved. Check its outcome before retrying to avoid repeating work.",
  }[event.kind];
  const task = event.taskId ? `${event.taskKind === "cron" ? "Cron" : "Reminder"} ${event.taskId}` : "Schedule queue";
  return `⚠️ Pi schedule needs attention\n\n${task}\n${reason}\n\nOpen Pi to review the schedule. No automatic retry is running.`;
}

export function formatGoalCompletionMessage(
  event: GoalCompletedEvent,
  details: TelegramGoalDetails,
): string {
  const lines = ["✅ Pi goal completed"];
  if (details === "minimal") return lines[0]!;

  lines.push("", "Objective:", clean(event.goal.objective));
  const finished = event.goal.checks.filter((check) => check.status === "complete" || check.status === "cancelled").length;
  if (event.goal.checks.length > 0) lines.push("", `Progress: ${finished}/${event.goal.checks.length} checks`);
  lines.push(
    `Tokens: ${formatTokens(event.goal.tokensUsed)}`,
    `Elapsed: ${formatDuration(event.goal.timeUsedMs)}`,
    `Turns: ${event.goal.turns}`,
  );
  if (event.goal.progressSummary) lines.push("", "Summary:", clean(event.goal.progressSummary));

  if (details === "full" && event.goal.checks.length > 0) {
    lines.push("", "Checks:");
    for (const check of event.goal.checks) lines.push(formatCheck(check));
  }

  return truncateMessage(lines.join("\n"), TELEGRAM_MESSAGE_LIMIT);
}

export function truncateMessage(value: string, limit: number): string {
  if (limit < 2) throw new Error("Telegram message limit must be at least 2.");
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  return `${characters.slice(0, limit - 1).join("").trimEnd()}…`;
}

function formatCheck(check: GoalCheck): string {
  const symbol = check.status === "complete" ? "✓" : check.status === "cancelled" ? "–" : "•";
  return `${symbol} ${clean(check.content)}`;
}

function clean(value: string): string {
  return value
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
}
