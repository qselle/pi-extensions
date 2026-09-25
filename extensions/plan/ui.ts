import type { Theme } from "@earendil-works/pi-coding-agent";
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
  planLeaves,
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
  return theme.bold(` Plan ${progressLabel(plan)} `);
}

export function renderPlanSummary(plan: PlanState, width: number, theme: Theme): string {
  if (width <= 0 || planStats(plan.items).unfinished === 0) return "";
  const current = currentPlanItem(plan)!;
  const label = `${theme.fg("muted", `Plan ${progressLabel(plan)}`)}${theme.fg("dim", " · ")}`;
  const body = `${theme.fg("accent", "●")} ${theme.fg("text", current.step)}`;
  const hint = width >= 80 ? theme.fg("dim", "/plan") : "";
  const available = Math.max(0, width - (hint ? visibleWidth(hint) + 2 : 0));
  const line = truncateToWidth(label + body, available, "…");
  return line + (hint ? " ".repeat(Math.max(2, width - visibleWidth(line) - visibleWidth(hint))) + hint : "");
}

export function renderPlanOverlayBody(
  plan: PlanState,
  width: number,
  maxHeight: number,
  theme: Theme,
): string[] {
  const stats = planStats(plan.items);
  if (stats.unfinished === 0 || width <= 0 || maxHeight <= 0) return [];

  const current = currentPlanItem(plan)!;
  const next = planLeaves(plan.items).find((item) => item.status === "pending");
  const body = [itemLine(current, theme, width)];
  if (next && maxHeight > 1) body.push(truncateToWidth(theme.fg("dim", "Next  ") + theme.fg("muted", next.step), width, "…"));
  if (stats.unfinished > 2 && maxHeight > 2) body.push(truncateToWidth(theme.fg("dim", `+${stats.unfinished - 2} more · /plan`), width, "…"));
  return body;
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
    if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.done("close"); return; }
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
    if (width <= 0) return [];
    const stats = planStats(this.plan.items);
    const innerWidth = Math.max(1, width - 4);
    const maxRows = Math.max(1, Math.floor(this.terminalRows() * 0.8));
    if (maxRows < 8) {
      return [renderPlanSummary(this.plan, width, this.theme) || this.theme.fg("muted", `Plan ${progressLabel(this.plan)}`),
        this.theme.fg("dim", panelHint(this.plan, width))].slice(0, maxRows).map((line) => truncateToWidth(line, width, "…"));
    }
    const body = [this.theme.fg("muted", `${stats.finished}/${stats.total} finalized · ${stats.completed} completed${stats.cancelled ? ` · ${stats.cancelled} cancelled` : ""}`)];
    if (this.plan.explanation && maxRows >= 12) body.push(...wrapTextWithAnsi(this.theme.fg("dim", this.plan.explanation), innerWidth).slice(0, 2));
    body.push("");
    const rows = this.rows();
    const selected = Math.max(0, rows.findIndex((row) => row.path === this.selected));
    const description = rows[selected]?.item.description;
    const detailLines = description && maxRows >= 12 ? wrapTextWithAnsi(this.theme.fg("muted", description), innerWidth) : [];
    const details = detailLines.slice(0, 3);
    if (detailLines.length > 3) details[2] = this.theme.fg("dim", truncateToWidth("More details: /plan status", innerWidth, "…"));
    const budget = Math.max(1, maxRows - body.length - 4 - (details.length ? details.length + 1 : 0));
    const start = Math.min(Math.max(0, selected - Math.floor(budget / 2)), Math.max(0, rows.length - budget));
    for (const row of rows.slice(start, start + budget)) {
      const prefix = `${row.path === this.selected ? "›" : " "} ${"  ".repeat(row.depth)}${row.item.children ? this.collapsed.has(row.path) ? "▸ " : "▾ " : "  "}`;
      body.push(truncateToWidth(prefix + itemLine(row.item, this.theme, Math.max(1, innerWidth - visibleWidth(prefix))), innerWidth, "…"));
    }
    if (!rows.length) body.push(this.theme.fg("dim", "No plan yet. Use update_plan."));
    if (rows.length > budget) body.push(this.theme.fg("dim", `${start + 1}–${Math.min(rows.length, start + budget)} / ${rows.length} visible steps`));
    if (details.length) body.push("", ...details);
    body.push(this.theme.fg("dim", panelHint(this.plan, innerWidth)));
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
    if (width <= 0) return [];
    const stats = planStats(this.plan.items);
    const title = !stats.total ? "Plan cleared" : stats.unfinished ? "Plan updated" : stats.cancelled ? "Plan closed" : "Plan complete";
    const lines = [
      `${this.theme.fg("accent", "•")} ${this.theme.bold(title)}${stats.total ? this.theme.fg("muted", ` · ${progressLabel(this.plan)}`) : ""}`,
    ];
    if (!this.expanded) {
      const current = stats.unfinished ? currentPlanItem(this.plan) : undefined;
      if (current) lines[0] += this.theme.fg("muted", ` · ${current.step}`);
      return lines.map(line => truncateToWidth(line, width, "…"));
    }
    if (this.plan.explanation) lines.push(this.theme.fg("dim", truncateToWidth(this.plan.explanation, width, "…")));
    for (const { item, depth } of planRows(this.plan.items)) {
      lines.push(itemLine({ ...item, step: "  ".repeat(depth) + item.step }, this.theme, width));
      if (item.description) {
        const indent = " ".repeat(Math.min((depth + 1) * 2, Math.max(0, width - 1)));
        lines.push(...wrapTextWithAnsi(this.theme.fg("dim", item.description), width - indent.length).map((line) => indent + line));
      }
    }
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}
}

export function renderPlanText(plan: PlanState): string {
  const stats = planStats(plan.items);
  const current = currentPlanItem(plan);
  const lines = [`Plan ${progressLabel(plan)}`];
  if (plan.explanation) lines.push(plan.explanation);
  if (current && stats.unfinished > 0) lines.push(`Current: ${current.step}`);
  for (const { item, depth } of planRows(plan.items)) {
    lines.push(`${"  ".repeat(depth)}${plainIcon(item.status)} ${item.step}${groupProgress(item)}`);
    if (item.description) lines.push(`${"  ".repeat(depth + 1)}${item.description}`);
  }
  return lines.join("\n");
}

function progressLabel(plan: PlanState): string {
  const stats = planStats(plan.items);
  return `${stats.completed}/${stats.total}${stats.cancelled ? ` · ${stats.cancelled} cancelled` : ""}`;
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

function panelHint(plan: PlanState, width: number): string {
  let help = "q/esc close";
  for (const hint of ["↑↓ move", "←→ fold", "space toggle", ...(plan.items.length ? ["c clear"] : [])]) {
    if (visibleWidth(`${help} · ${hint}`) <= width) help += ` · ${hint}`;
  }
  return help;
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
