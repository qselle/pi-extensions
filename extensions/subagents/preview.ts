import { isActive, type AgentSnapshot } from "./coordinator.ts";

export const COLLAPSED_RESULT_ROWS = 5;
const COLLAPSED_RESULT_LINE_CHARS = 200;

export interface ResultHeadline {
  action: string;
  agents: readonly AgentSnapshot[];
  timedOut?: boolean;
  interrupted?: boolean;
}

export interface CollapsedResult {
  /** Output lines to display, newest last. */
  lines: string[];
  /** Number of earlier lines the preview dropped. */
  hidden: number;
}

/**
 * A wait result is ambiguous without knowing what is still outstanding, so the
 * headline states the outcome and how many children remain running.
 */
export function headlineSuffix(details: ResultHeadline): string {
  const parts: string[] = [];
  if (details.interrupted) parts.push("interrupted");
  else if (details.timedOut) parts.push("timed out");
  if (details.action === "wait") {
    const running = details.agents.filter(isActive).length;
    if (running > 0) parts.push(`${running} still running`);
    else if (parts.length === 0) parts.push("all settled");
  }
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/**
 * Collapsed results keep the tail of the output, where a child agent states its
 * conclusion, instead of the first sentence of its preamble.
 */
export function collapsedResult(output: string, rows = COLLAPSED_RESULT_ROWS): CollapsedResult {
  const lines = output
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => compactLine(line, COLLAPSED_RESULT_LINE_CHARS))
    .filter((line) => line.length > 0);
  if (lines.length <= rows) return { lines, hidden: 0 };
  const kept = lines.slice(1 - rows);
  return { lines: kept, hidden: lines.length - kept.length };
}

export function hiddenLinesMarker(hidden: number): string {
  return `… +${hidden} earlier ${hidden === 1 ? "line" : "lines"} (Ctrl+O for full output)`;
}

export function compactLine(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}
