import type { Theme } from "@earendil-works/pi-coding-agent";
import { expansionHint } from "../../lib/tool-ui.ts";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import {
  currentPlanItem,
  planStats,
  planRows,
  type PlanItem,
  type PlanItemStatus,
  type PlanState,
} from "./plan.ts";

export type PlanPanelAction = "close" | "clear";

export class PlanOverlayCard implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly getPlan: () => PlanState,
  ) {}

  render(width: number): string[] {
    const plan = this.getPlan();
    const stats = planStats(plan.items);
    if (stats.unfinished === 0 || width < 24) return [];
    const innerWidth = Math.max(1, width - 4);
    return frame(
      planOverlayTitle(plan, this.theme),
      renderPlanOverlayBody(plan, innerWidth, 6, this.theme),
      width,
      this.theme,
      "accent",
    );
  }

  invalidate(): void {}
}

export function planOverlayTitle(plan: PlanState, theme: Theme): string {
  const stats = planStats(plan.items);
  return theme.bold(` Plan ${stats.finished}/${stats.total} `);
}

export function renderPlanOverlayBody(
  plan: PlanState,
  width: number,
  maxHeight: number,
  theme: Theme,
): string[] {
  const stats = planStats(plan.items);
  if (stats.unfinished === 0 || width <= 0 || maxHeight <= 0) return [];

  const body: string[] = [];
  if (plan.explanation && maxHeight >= 3) body.push(theme.fg("dim", theme.italic(truncateToWidth(plan.explanation, width, "…"))));

  const itemBudget = Math.max(1, maxHeight - body.length);
  const rows = planRows(plan.items).map(({ item, depth }) => ({ ...item, step: "  ".repeat(depth) + item.step }));
  const showHints = itemBudget >= 4 && rows.length > itemBudget;
  const selection = selectOverlayItems(rows, showHints ? itemBudget - 2 : itemBudget);
  if (showHints && selection.hiddenBefore > 0) body.push(theme.fg("dim", `… ${selection.hiddenBefore} earlier`));
  for (const item of selection.items) body.push(itemLine(item, theme, width));
  if (showHints && selection.hiddenAfter > 0) body.push(theme.fg("dim", `… ${selection.hiddenAfter} later`));

  if (body.length <= maxHeight) return body.map((line) => truncateToWidth(line, width, ""));
  const visible = body.slice(0, maxHeight);
  visible[maxHeight - 1] = theme.fg("dim", "… /plan for full details");
  return visible.map((line) => truncateToWidth(line, width, ""));
}

export class PlanPanel implements Component {
  private collapsed = new Set<string>();
  private selected = "0";
  constructor(
    private readonly plan: PlanState,
    private readonly theme: Theme,
    private readonly done: (action: PlanPanelAction) => void,
    private readonly requestRender: () => void = () => {},
    private readonly terminalRows: () => number = () => 30,
  ) {
    for (const row of planRows(plan.items)) if (row.item.children && row.item.status !== "in_progress") this.collapsed.add(row.path);
    this.selected = this.rows().find((row) => !row.item.children && row.item.status === "in_progress")?.path ?? "0";
  }
  private rows() { return planRows(this.plan.items, this.collapsed); }
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.done("close"); return; }
    if (matchesKey(data, "c") && this.plan.items.length > 0) { this.done("clear"); return; }
    const rows = this.rows();
    const index = Math.max(0, rows.findIndex((row) => row.path === this.selected));
    const row = rows[index];
    if (!row) return;
    if (matchesKey(data, "up")) this.selected = rows[Math.max(0, index - 1)]!.path;
    else if (matchesKey(data, "down")) this.selected = rows[Math.min(rows.length - 1, index + 1)]!.path;
    else if (matchesKey(data, "left")) {
      if (row.item.children && !this.collapsed.has(row.path)) this.collapsed.add(row.path);
      else if (row.path.includes(".")) this.selected = row.path.slice(0, row.path.lastIndexOf("."));
    } else if (matchesKey(data, "right")) {
      if (row.item.children) { if (this.collapsed.has(row.path)) this.collapsed.delete(row.path); else this.selected = `${row.path}.0`; }
    } else if (data === " " && row.item.children) {
      if (this.collapsed.has(row.path)) this.collapsed.delete(row.path); else this.collapsed.add(row.path);
    } else return;
    this.requestRender();
  }
  render(width: number): string[] {
    const stats = planStats(this.plan.items);
    const innerWidth = Math.max(1, width - 4);
    const maxRows = Math.max(1, Math.floor(this.terminalRows() * 0.8));
    const body = [this.theme.fg("muted", `${stats.finished}/${stats.total} finalized · ${stats.completed} completed${stats.cancelled ? ` · ${stats.cancelled} cancelled` : ""}`)];
    if (this.plan.explanation) body.push(...wrapTextWithAnsi(this.theme.fg("dim", this.plan.explanation), innerWidth).slice(0, 2));
    body.push("");
    const rows = this.rows();
    const budget = Math.max(1, maxRows - body.length - 4);
    const selected = Math.max(0, rows.findIndex((row) => row.path === this.selected));
    const start = Math.min(Math.max(0, selected - Math.floor(budget / 2)), Math.max(0, rows.length - budget));
    for (const row of rows.slice(start, start + budget)) {
      const prefix = `${row.path === this.selected ? "›" : " "} ${"  ".repeat(row.depth)}${row.item.children ? this.collapsed.has(row.path) ? "▸ " : "▾ " : "  "}`;
      body.push(truncateToWidth(prefix + itemLine(row.item, this.theme, Math.max(1, innerWidth - visibleWidth(prefix))), innerWidth, "…"));
    }
    if (!rows.length) body.push(this.theme.fg("dim", "No plan yet. Use update_plan."));
    if (rows.length > budget) body.push(this.theme.fg("dim", `${start + 1}–${Math.min(rows.length, start + budget)} / ${rows.length} visible steps`));
    body.push(this.theme.fg("dim", "↑↓ move · ←→ fold · space toggle · " + panelHint(this.plan)));
    return frame(" Execution plan ", body, width, this.theme, "border").slice(0, maxRows);
  }
  invalidate(): void {}
}

export class PlanToolResult implements Component {
  constructor(
    private readonly plan: PlanState,
    private readonly theme: Theme,
    private readonly expanded = false,
  ) {}

  render(width: number): string[] {
    const stats = planStats(this.plan.items);
    const lines = [
      `${this.theme.fg("accent", "•")} ${this.theme.bold("Plan updated")} ${this.theme.fg("muted", `${stats.finished}/${stats.total}`)}`,
    ];
    if (!this.expanded) {
      const current = currentPlanItem(this.plan);
      if (current) lines.push(this.theme.fg("text", `  ${current.step}`));
      lines.push(this.theme.fg("dim", `  ${expansionHint()} · /plan`));
      return width <= 0 ? [] : lines.map(line => truncateToWidth(line, width, "…"));
    }
    if (this.plan.explanation) lines.push(this.theme.fg("dim", truncateToWidth(this.plan.explanation, width, "…")));
    for (const { item, depth } of planRows(this.plan.items)) lines.push(itemLine({ ...item, step: "  ".repeat(depth) + item.step }, this.theme, width));
    if (this.plan.items.length === 0) lines.push(this.theme.fg("dim", "Plan cleared"));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}
}

export function renderPlanText(plan: PlanState): string {
  const stats = planStats(plan.items);
  const current = currentPlanItem(plan);
  const lines = [`Plan ${stats.finished}/${stats.total}`];
  if (plan.explanation) lines.push(plan.explanation);
  if (current && stats.unfinished > 0) lines.push(`Current: ${current.step}`);
  for (const { item, depth } of planRows(plan.items)) lines.push(`${"  ".repeat(depth)}${plainIcon(item.status)} ${item.step}${groupProgress(item)}`);
  return lines.join("\n");
}

function selectOverlayItems(items: readonly PlanItem[], limit: number): {
  items: PlanItem[];
  hiddenBefore: number;
  hiddenAfter: number;
} {
  if (items.length <= limit) return { items: [...items], hiddenBefore: 0, hiddenAfter: 0 };
  const currentIndex = Math.max(0, items.findIndex((item) => item.status === "in_progress" && !item.children));
  const start = Math.min(Math.max(0, currentIndex - Math.floor(limit / 2)), items.length - limit);
  return {
    items: items.slice(start, start + limit),
    hiddenBefore: start,
    hiddenAfter: items.length - start - limit,
  };
}

function itemLine(item: PlanItem, theme: Theme, width: number): string {
  const icon = styledIcon(item.status, theme);
  const content = styledItemContent(item, theme);
  return truncateToWidth(`${icon} ${content}`, width, "…");
}


function groupProgress(item: PlanItem): string {
  if (!item.children) return "";
  const stats = planStats(item.children);
  return ` (${stats.finished}/${stats.total}${stats.cancelled ? ` · ${stats.cancelled} cancelled` : ""})`;
}

function styledItemContent(item: PlanItem, theme: Theme): string {
  const label = item.step + groupProgress(item);
  if (item.status === "completed" || item.status === "cancelled") {
    return theme.fg("dim", theme.strikethrough(label));
  }
  if (item.status === "in_progress") return theme.fg("accent", theme.bold(label));
  return theme.fg("muted", label);
}

function styledIcon(status: PlanItemStatus, theme: Theme): string {
  if (status === "completed") return theme.fg("success", "✓");
  if (status === "in_progress") return theme.fg("accent", "●");
  if (status === "cancelled") return theme.fg("dim", "−");
  return theme.fg("dim", "○");
}

function plainIcon(status: PlanItemStatus): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "●";
  if (status === "cancelled") return "−";
  return "○";
}

function panelHint(plan: PlanState): string {
  return [plan.items.length > 0 ? "c clear" : undefined, "esc close"].filter(Boolean).join("  ·  ");
}

function frame(
  rawTitle: string,
  body: readonly string[],
  width: number,
  theme: Theme,
  borderColor: "accent" | "border",
): string[] {
  if (width <= 0) return [];
  if (width === 1) return [theme.fg(borderColor, "│")];
  const contentWidth = Math.max(0, width - 4);
  const title = truncateToWidth(rawTitle, Math.max(1, width - 2), "…");
  const ruleWidth = Math.max(0, width - visibleWidth(title) - 2);
  const top = `${theme.fg(borderColor, "╭")}${title}${theme.fg(borderColor, "─".repeat(ruleWidth))}${theme.fg(borderColor, "╮")}`;
  const lines = body.map((raw) => {
    const content = truncateToWidth(raw, contentWidth, "…");
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
    return `${theme.fg(borderColor, "│ ")}${content}${padding}${theme.fg(borderColor, " │")}`;
  });
  const bottom = theme.fg(borderColor, `╰${"─".repeat(Math.max(0, width - 2))}╯`);
  return [top, ...lines, bottom].map((line) => truncateToWidth(line, width, ""));
}
