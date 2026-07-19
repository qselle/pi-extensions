import type { GoalCompletedEvent } from "../goal/events.ts";
import type { GoalCheck } from "../goal/goal.ts";
import type { TelegramGoalDetails } from "./config.ts";

export const TELEGRAM_MESSAGE_LIMIT = 3_500;

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
