import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { compactInlineText, contextColor, formatCost, formatPercent, formatTokens, type ContextUsageLike, type UsageTotals } from "./format.ts";

type Color = Parameters<Theme["fg"]>[0];
type FooterTheme = Pick<Theme, "fg">;
interface Segment { text: string; color: Color; label?: string }
interface Reduction { priority: number; segments: Segment[] }
interface Group { zone: "identity" | "usage" | "workspace"; segments: Segment[]; reductions: Reduction[] }
export interface FooterView {
  session: string;
  model: string;
  badges: readonly string[];
  usage: ContextUsageLike | undefined;
  contextWindow?: number;
  totals: UsageTotals;
  directory: string;
  branch?: string | null;
  git?: string;
  gitConflicts?: boolean;
  statuses?: Iterable<readonly [string, string]>;
}

const segment = (text: string, color: Color, label?: string): Segment => ({ text, color, label });
const plain = (segments: Segment[]) => segments.map(({ text, label }) => `${label ? `${label} ` : ""}${text}`).join(" ");
const styled = (segments: Segment[], theme: FooterTheme) => segments.map(({ text, color, label }) =>
  `${label ? `${theme.fg("muted", label)} ` : ""}${theme.fg(color, text)}`).join(" ");
const shorten = (value: string, width: number) => truncateToWidth(value, width, "…");
function shortenModel(model: string, width: number): string {
  if (visibleWidth(model) <= width) return model;
  const effort = / (minimal|low|medium|high|xhigh|max)$/.exec(model)?.[0] ?? "";
  return shorten(effort ? model.slice(0, -effort.length) : model, Math.max(1, width - effort.length)) + effort;
}

type UsageField = "input" | "output" | "cacheRead" | "cacheWrite" | "cost";
function usageSegment(totals: UsageTotals, key: UsageField, label?: string): Segment {
  const value = totals[key] ?? 0;
  const missing = totals.missing?.[key] ?? 0;
  const formatted = key === "cost" ? formatCost(value) : formatTokens(value);
  if (!missing) return segment(formatted, "text", label);
  if (missing >= (totals.responses ?? missing)) return segment(key === "cost" ? "$?" : "?", "muted", label);
  return segment(`≥${formatted}`, "warning", label);
}

/** Keep metrics contextual; optional detail gives way before core identity and context. */
function groupsFor(input: FooterView): Group[] {
  const groups: Group[] = [];
  const add = (zone: Group["zone"], segments: Segment[], reductions: Reduction[] = []) => {
    if (plain(segments)) groups.push({ zone, segments, reductions });
  };
  const hide = (priority: number): Reduction => ({ priority, segments: [] });
  const session = compactInlineText(input.session, 80) || "pi";
  const model = shortenModel(compactInlineText(input.model, Number.MAX_SAFE_INTEGER) || "no-model", 160);
  add("identity", [segment(model, "accent")], [
    { priority: 60, segments: [segment(shortenModel(model, 24), "accent")] },
    { priority: 20, segments: [segment(shortenModel(model, 16), "accent")] },
    { priority: 8, segments: [segment(shortenModel(model, 10), "accent")] }, hide(5),
  ]);
  add("identity", [segment(session, "muted")], [hide(98)]);
  if (input.badges.length) add("identity", input.badges.map((badge) => segment(compactInlineText(badge, 18), "muted")), [hide(92)]);

  const window = input.usage?.contextWindow ?? input.contextWindow;
  const percent = formatPercent(input.usage?.percent);
  const pressure = contextColor(input.usage?.percent);
  const tone: Color = pressure === "success" ? "text" : pressure;
  const capacity = window && window > 0 ? formatTokens(window) : "?";
  const used = formatTokens(input.usage?.tokens);
  add("usage", [segment(`${percent} ${used}/${capacity}`, tone, "context")], [
    { priority: 45, segments: [segment(percent, tone, "context")] },
  ]);
  const { totals } = input;
  const cached = totals.cacheRead ?? 0, written = totals.cacheWrite ?? 0;
  const prompt = totals.input + cached + written;
  const promptFields = ["input", "cacheRead", "cacheWrite"] as const;
  const incompletePrompt = promptFields.some((key) => (totals.missing?.[key] ?? 0) > 0);
  const hit = prompt > 0 && !incompletePrompt ? 100 * cached / prompt : undefined;
  add("usage", [usageSegment(totals, "input", "in"), usageSegment(totals, "output", "out")], [hide(40)]);
  const reads = cached > 0 || totals.missing?.cacheRead ? [usageSegment(totals, "cacheRead", "R")] : [];
  const writes = written > 0 || totals.missing?.cacheWrite ? [usageSegment(totals, "cacheWrite", "W")] : [];
  const hits = hit !== undefined || incompletePrompt
    ? [segment(hit === undefined ? "?" : formatPercent(hit), hit === undefined ? "muted" : "text", "hit")] : [];
  const cacheGroup = (parts: Segment[]) => parts.length ? [segment("cache", "muted"), ...parts] : [];
  // Keep the shared label through every reduction; never leave unexplained R/W
  // counters behind when another metric yields to a narrower terminal.
  add("usage", cacheGroup([...reads, ...writes, ...hits]), [
    ...(writes.length ? [{ priority: 80, segments: cacheGroup([...reads, ...hits]) }] : []),
    ...(reads.length ? [{ priority: 70, segments: cacheGroup(hits) }] : []),
    hide(65),
  ]);
  add("usage", [usageSegment(totals, "cost")]);

  const directory = compactInlineText(input.directory, 500);
  const basename = directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory;
  if (directory) add("workspace", [segment(directory, "muted")], [
    { priority: 99, segments: [segment(shorten(basename, 24), "muted")] }, hide(30),
  ]);
  const branch = compactInlineText(input.branch, 160);
  if (branch) add("workspace", [segment(branch, "muted")], [
    { priority: 96, segments: [segment(shorten(branch, 20), "muted")] }, hide(50),
  ]);
  if (input.git) {
    const git = compactInlineText(input.git, 160);
    const counts = [...git.matchAll(/\b(conflicts|staged|changed|new|ahead|behind) (\d+)\b/g)];
    const conflict = input.gitConflicts ? counts.find((match) => match[1] === "conflicts") : undefined;
    const details = counts.length ? [segment("git", "muted"), ...counts.map((match) =>
      segment(match[2]!, match === conflict ? "error" : "text", match[1]!))] : [segment(git, "muted")];
    add("workspace", details, conflict ? [
      { priority: 75, segments: [segment(conflict[2]!, "error", "conflicts")] }, hide(2),
    ] : [hide(75)]);
  }
  const statuses = [...input.statuses ?? []].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, text]) => {
    const clean = compactInlineText(text, 160);
    return clean ? [segment(clean, "muted")] : [];
  });
  if (statuses.length) add("workspace", statuses, [hide(90)]);
  return groups;
}

function joinGroups(groups: Group[], theme?: FooterTheme, available = 0): string {
  const dim = (value: string) => theme ? theme.fg("dim", value) : value;
  const zones = (["identity", "usage", "workspace"] as const).map((zone) => groups
    .filter((group) => group.zone === zone && group.segments.length)
    .map((group) => theme ? styled(group.segments, theme) : plain(group.segments))
    .join(dim(" · ")));
  const divider = " │ ";
  const main = zones.slice(0, 2).filter(Boolean).join(dim(divider));
  const workspace = zones[2]!;
  if (!workspace) return main;
  if (!main) return workspace;
  // Right-anchor workspace details only after all selected data fits.
  const gap = Math.max(0, available - visibleWidth(main) - visibleWidth(workspace) - divider.length);
  return main + " ".repeat(gap) + dim(divider) + workspace;
}

/** Exactly one terminal row: preserve readable labels and hide optional fields. */
export function renderFooter(input: FooterView, width: number, theme: FooterTheme): string[] {
  if (width <= 0) return [];
  const margin = width >= 12 ? 1 : 0;
  const available = Math.max(1, width - margin * 2);
  const groups = groupsFor(input);
  while (visibleWidth(joinGroups(groups)) > available) {
    const next = groups.filter((group) => group.reductions.length)
      .sort((a, b) => b.reductions[0]!.priority - a.reductions[0]!.priority)[0];
    if (!next) break;
    next.segments = next.reductions.shift()!.segments;
  }
  return [" ".repeat(margin) + truncateToWidth(joinGroups(groups, theme, available), available, "")];
}
