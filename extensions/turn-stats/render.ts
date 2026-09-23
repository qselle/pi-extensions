import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitCells, formatCost, formatTokens } from "../footer/format.ts";
import { formatDuration, formatLatency, formatRate } from "../turn-separator/stats.ts";
import { FIELDS, summaryText, type Summary, type Totals } from "./stats.ts";

/** Old entries can use Pi's persisted entry timestamp without changing their accounting. */
export function completionClock(summary: Summary, entryTimestamp?: string): string | undefined {
  const timestamp = summary.endedAt ?? (entryTimestamp ? Date.parse(entryTimestamp) : NaN);
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > 8.64e15) return;
  return new Intl.DateTimeFormat(undefined, { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
}

function amount(total: Totals, responses: number, formatter: (value: number) => string = formatTokens): string {
  if (responses > 0 && total.missing === responses) return "?";
  return `${total.missing ? "≥" : ""}${formatter(total.known)}`;
}

/** Work/timing and token/cost rows, backed by full-run and partial-data accounting. */
function completionGroups(summary: Summary, theme: Theme, entryTimestamp?: string): [string[], string[]] {
  const label = (value: string) => theme.fg("muted", value);
  const styledValue = (value: string, color: Parameters<Theme["fg"]>[0] = "text") =>
    theme.fg(value.startsWith("?") || value === "—" ? "muted" : value.startsWith("≥") ? "warning" : color, value);
  const field = (label: string, value: string, color: Parameters<Theme["fg"]>[0] = "text") =>
    `${theme.fg("muted", label)} ${styledValue(value, color)}`;
  const groups: string[] = [];
  if (summary.outcome !== "settled") groups.push(theme.fg(summary.outcome === "error" ? "error" : "warning", summary.outcome));
  if (summary.failedTools) groups.push(theme.fg("error", `${summary.failedTools} failed tool${summary.failedTools === 1 ? "" : "s"}`));
  const clock = completionClock(summary, entryTimestamp);
  if (clock) groups.push(field("finished", clock));
  groups.push(field("turn duration", summary.durationMs < 500 ? "<1s" : formatDuration(summary.durationMs / 1000), "accent"));
  groups.push(`${styledValue(String(summary.responses))} ${label(summary.responses === 1 ? "reply" : "replies")}`, `${styledValue(String(summary.tools))} ${label(summary.tools === 1 ? "tool" : "tools")}`);
  const timing = summary.timing;
  const coverage = (count: number) => label(`(${count}/${summary.responses} replies)`);
  const latency = timing?.latencySamples ? formatLatency(timing.latencyMs / timing.latencySamples) : "?";
  const rate = timing?.streamSamples ? `${formatRate(timing.outputTokens / (timing.streamMs / 1000))} tokens/s` : "unknown";
  groups.push(`${field("first token avg", latency)} ${coverage(timing?.latencySamples ?? 0)}`, `${field("rate", rate)} ${coverage(timing?.streamSamples ?? 0)}`);

  const usage = summary.usage;
  const promptTotals = [usage.input, usage.cacheRead, usage.cacheWrite];
  const completePrompt = promptTotals.every((total) => total.missing === 0);
  const unknownPrompt = summary.responses > 0 && promptTotals.every((total) => total.missing === summary.responses);
  const prompt = promptTotals.reduce((total, value) => total + value.known, 0);
  const promptText = unknownPrompt ? "?" : `${completePrompt ? "" : "≥"}${formatTokens(prompt)}`;
  // A percentage from a partial denominator would look more certain than it is.
  const hit = !completePrompt ? "?" : prompt > 0 ? `${Math.round(100 * usage.cacheRead.known / prompt)}%` : "—";
  const tokenGroups = [
    field("prompt", promptText),
    field("in", amount(usage.input, summary.responses)), field("out", amount(usage.output, summary.responses)),
    field("cache read", amount(usage.cacheRead, summary.responses)), field("cache write", amount(usage.cacheWrite, summary.responses)),
    field("cache hit", hit),
    field("cost", amount(usage.cost, summary.responses, formatCost)),
  ];
  if (FIELDS.some((key) => usage[key].missing > 0)) tokenGroups.push(theme.fg("warning", "partial usage"));
  return [groups, tokenGroups];
}

export function completionRows(summary: Summary, theme: Theme, entryTimestamp?: string): [string, string] {
  const [work, usage] = completionGroups(summary, theme, entryTimestamp);
  return [work.join(theme.fg("dim", " · ")), usage.join(theme.fg("dim", " · "))];
}

export function renderCompletion(summary: Summary, width: number, theme: Theme, expanded: boolean, entryTimestamp?: string): string[] {
  if (!Number.isFinite(width) || width <= 0) return [];
  width = Math.floor(width);
  if (!width) return [];
  const dim = (text: string) => theme.fg("dim", text);
  const usage = summary.usage;
  const promptComplete = [usage.input, usage.cacheRead, usage.cacheWrite].every((total) => total.missing === 0);
  const prompt = usage.input.known + usage.cacheRead.known + usage.cacheWrite.known;
  const hit = !promptComplete ? "?" : prompt > 0 ? `${Math.round(100 * usage.cacheRead.known / prompt)}%` : "—";
  const value = (text: string, color: Parameters<Theme["fg"]>[0] = "text") => theme.fg(text.startsWith("≥") ? "warning" : text.includes("?") || text === "—" ? "muted" : color, text);
  const field = (label: string, text: string) => `${theme.fg("muted", label)} ${value(text)}`;
  const cells: { text: string; priority: number }[] = [];
  if (summary.outcome !== "settled") cells.push({ text: theme.fg(summary.outcome === "error" ? "error" : "warning", summary.outcome), priority: 0 });
  if (summary.failedTools) cells.push({ text: theme.fg("error", `${summary.failedTools} failed tool${summary.failedTools === 1 ? "" : "s"}`), priority: 0 });
  cells.push(
    { text: value(`Turn ${summary.durationMs < 500 ? "<1s" : formatDuration(summary.durationMs / 1000)}`, "accent"), priority: 0 },
    { text: `${field("in", amount(usage.input, summary.responses))}${dim(" · ")}${field("out", amount(usage.output, summary.responses))}`, priority: 20 },
    { text: value(amount(usage.cost, summary.responses, formatCost).replace(/^\?$/, "$?")), priority: 10 },
  );
  if (prompt > 0 || !promptComplete) cells.push({ text: field("cache hit", hit), priority: 30 });
  const timing = summary.timing;
  const coverage = (count: number) => count < summary.responses ? theme.fg("muted", ` (${count}/${summary.responses} replies)`) : "";
  if (timing?.streamSamples) cells.push({ text: `${value(formatRate(timing.outputTokens / (timing.streamMs / 1000)))} ${theme.fg("muted", "tokens/s")}${coverage(timing.streamSamples)}`, priority: 40 });
  if (timing?.latencySamples) cells.push({ text: `${field("first token", formatLatency(timing.latencyMs / timing.latencySamples))}${coverage(timing.latencySamples)}`, priority: 50 });
  cells.push(
    { text: `${value(String(summary.responses))} ${theme.fg("muted", summary.responses === 1 ? "reply" : "replies")}`, priority: 60 },
  );
  if (summary.tools) cells.push({ text: `${value(String(summary.tools))} ${theme.fg("muted", summary.tools === 1 ? "tool" : "tools")}`, priority: 60 });
  if (usage.cacheRead.known || usage.cacheRead.missing) cells.push({ text: field("cache read", amount(usage.cacheRead, summary.responses)), priority: 70 });
  if (usage.cacheWrite.known || usage.cacheWrite.missing) cells.push({ text: field("cache write", amount(usage.cacheWrite, summary.responses)), priority: 70 });
  const clock = completionClock(summary, entryTimestamp);
  if (clock) cells.push({ text: field("finished", clock), priority: 90 });
  const padding = width > 2 ? 1 : 0;
  const budget = width - padding * 2;
  const fitted = fitCells(cells, budget, 3, visibleWidth).map((cell) => cell.text).join(dim(" · "));
  const rows = [`${" ".repeat(padding)}${truncateToWidth(fitted, budget, "…")}`];
  if (expanded) {
    for (const line of completionRows(summary, theme, entryTimestamp)) rows.push(...new Text(line, padding, 0).render(width));
    rows.push(...new Text(theme.fg("muted", summaryText(summary, true)), padding, 0).render(width));
  }
  return rows.map((line) => truncateToWidth(line, width, "…"));
}
