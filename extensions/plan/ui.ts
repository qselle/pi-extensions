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
  if (plan.explanation) body.push(theme.fg("dim", theme.italic(truncateToWidth(plan.explanation, width, "…"))));

  const itemBudget = Math.max(1, maxHeight - body.length);
  const selection = selectOverlayItems(plan.items, itemBudget);
  if (selection.hiddenBefore > 0) body.push(theme.fg("dim", `… ${selection.hiddenBefore} earlier`));
  for (const item of selection.items) body.push(itemLine(item, theme, width));
  if (selection.hiddenAfter > 0) body.push(theme.fg("dim", `… ${selection.hiddenAfter} later`));

  if (body.length <= maxHeight) return body.map((line) => truncateToWidth(line, width, ""));
  const visible = body.slice(0, maxHeight);
  visible[maxHeight - 1] = theme.fg("dim", "… /plan for full details");
  return visible.map((line) => truncateToWidth(line, width, ""));
}

export class PlanPanel implements Component {
  constructor(
    private readonly plan: PlanState,
    private readonly theme: Theme,
    private readonly done: (action: PlanPanelAction) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.done("close");
    else if (matchesKey(data, "c") && this.plan.items.length > 0) this.done("clear");
  }

  render(width: number): string[] {
    const stats = planStats(this.plan.items);
    const innerWidth = Math.max(1, width - 4);
    const body: string[] = [];

    body.push(
      this.theme.fg("muted", `${stats.finished}/${stats.total} finalized`)
        + this.theme.fg("dim", ` · ${stats.completed} completed${stats.cancelled > 0 ? ` · ${stats.cancelled} cancelled` : ""}`),
    );
    if (this.plan.explanation) {
      body.push("");
      body.push(...wrapTextWithAnsi(this.theme.fg("dim", this.plan.explanation), innerWidth).slice(0, 3));
    }
    if (this.plan.items.length > 0) {
      body.push("");
      for (const item of this.plan.items) body.push(...wrappedItemLines(item, this.theme, innerWidth));
    } else {
      body.push("");
      body.push(this.theme.fg("dim", "No plan yet. The agent can create one with update_plan."));
    }
    body.push("");
    body.push(this.theme.fg("dim", panelHint(this.plan)));

    return frame(" Execution plan ", body, width, this.theme, "border");
  }

  invalidate(): void {}
}

export class PlanToolResult implements Component {
  constructor(
    private readonly plan: PlanState,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const stats = planStats(this.plan.items);
    const lines = [
      `${this.theme.fg("accent", "◆")} ${this.theme.bold("Plan updated")} ${this.theme.fg("dim", `${stats.finished}/${stats.total}`)}`,
    ];
    if (this.plan.explanation) lines.push(this.theme.fg("dim", truncateToWidth(this.plan.explanation, width, "…")));
    for (const item of this.plan.items) lines.push(itemLine(item, this.theme, width));
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
  for (const item of plan.items) lines.push(`${plainIcon(item.status)} ${item.step}`);
  return lines.join("\n");
}

function selectOverlayItems(items: readonly PlanItem[], limit: number): {
  items: PlanItem[];
  hiddenBefore: number;
  hiddenAfter: number;
} {
  if (items.length <= limit) return { items: [...items], hiddenBefore: 0, hiddenAfter: 0 };
  const currentIndex = Math.max(0, items.findIndex((item) => item.status === "in_progress"));
  const start = Math.min(Math.max(0, currentIndex - 1), items.length - limit);
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

function wrappedItemLines(item: PlanItem, theme: Theme, width: number): string[] {
  const icon = styledIcon(item.status, theme);
  const contentWidth = Math.max(1, width - 2);
  return wrapTextWithAnsi(styledItemContent(item, theme), contentWidth).map((line, index) =>
    truncateToWidth(`${index === 0 ? `${icon} ` : "  "}${line}`, width, ""),
  );
}

function styledItemContent(item: PlanItem, theme: Theme): string {
  if (item.status === "completed" || item.status === "cancelled") {
    return theme.fg("dim", theme.strikethrough(item.step));
  }
  if (item.status === "in_progress") return theme.fg("accent", theme.bold(item.step));
  return theme.fg("muted", item.step);
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
