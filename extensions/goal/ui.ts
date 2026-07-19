import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import {
  currentGoalCheck,
  formatDuration,
  formatTokens,
  goalCheckProgress,
  type GoalCheckStatus,
  type GoalState,
  type GoalStatus,
} from "./goal.ts";

export type GoalPanelAction = "close" | "edit" | "pause" | "resume" | "clear";

export class GoalWidget implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly getGoal: () => GoalState | undefined,
    private readonly getActiveRunStartedAt: () => number | undefined,
  ) {}

  render(width: number): string[] {
    const goal = this.getGoal();
    if (!goal || width < 20) return [];

    const elapsed = currentElapsed(goal, this.getActiveRunStartedAt());
    const progress = goalCheckProgress(goal);
    const metadata = [
      progress.total > 0 ? `${progress.complete}/${progress.total}` : undefined,
      formatDuration(elapsed),
      goal.tokenBudget === null
        ? undefined
        : `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`,
    ].filter(Boolean).join(" · ");
    const heading = `  ${this.theme.fg("accent", "◆")} ${this.theme.bold("Goal")}  ${styledStatus(goal.status, this.theme)} ${this.theme.fg("dim", `· ${metadata}`)}`;

    if (width < 42) return [truncateToWidth(heading, width, "…")];

    const check = currentGoalCheck(goal);
    const preview = goal.status === "blocked" && goal.blockerAudit
      ? `Blocked: ${goal.blockerAudit.description}`
      : check?.content ?? goal.objective;
    const marker = check ? checkIcon(check.status, this.theme) : this.theme.fg("borderMuted", "└");
    const prefix = `  ${marker} `;
    const budgetBar = goal.tokenBudget === null ? "" : ` ${progressBar(goal.tokensUsed, goal.tokenBudget, this.theme)}`;
    const previewWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(budgetBar));
    return [
      truncateToWidth(heading, width, "…"),
      truncateToWidth(`${prefix}${truncateToWidth(preview.replace(/\s+/g, " "), previewWidth, "…")}${budgetBar}`, width, "…"),
    ];
  }

  invalidate(): void {}
}

export class GoalPanel implements Component {
  constructor(
    private readonly goal: GoalState,
    private readonly theme: Theme,
    private readonly activeRunStartedAt: number | undefined,
    private readonly done: (action: GoalPanelAction) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.done("close");
    else if (matchesKey(data, "e")) this.done("edit");
    else if (matchesKey(data, "c")) this.done("clear");
    else if (matchesKey(data, "p") && this.goal.status === "active") this.done("pause");
    else if (
      matchesKey(data, "r")
      && (this.goal.status === "paused" || this.goal.status === "blocked" || this.goal.status === "usage_limited")
    ) this.done("resume");
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const elapsed = currentElapsed(this.goal, this.activeRunStartedAt);
    const progress = goalCheckProgress(this.goal);
    const lines: string[] = [];
    const border = (value: string) => this.theme.fg("borderMuted", value);

    lines.push(
      border("╭─")
        + this.theme.fg("accent", this.theme.bold(" Goal "))
        + border(`${"─".repeat(Math.max(0, width - 9))}╮`),
    );
    const meta = [
      formatDuration(elapsed),
      `${this.goal.turns} ${this.goal.turns === 1 ? "run" : "runs"}`,
      progress.total > 0 ? `${progress.complete}/${progress.total} checks` : undefined,
    ].filter(Boolean).join(" · ");
    lines.push(panelLine(`${styledStatus(this.goal.status, this.theme)} ${this.theme.fg("dim", `· ${meta}`)}`, innerWidth, border));
    lines.push(panelLine("", innerWidth, border));

    const wrappedObjective = wrapTextWithAnsi(this.theme.fg("text", this.goal.objective), innerWidth);
    for (const line of wrappedObjective.slice(0, 3)) lines.push(panelLine(line, innerWidth, border));
    if (wrappedObjective.length > 3) lines.push(panelLine(this.theme.fg("dim", "…"), innerWidth, border));

    if (this.goal.checks.length > 0) {
      lines.push(panelLine("", innerWidth, border));
      lines.push(panelLine(this.theme.fg("muted", this.theme.bold("Progress checks")), innerWidth, border));
      for (const check of this.goal.checks.slice(0, 5)) {
        const text = check.status === "complete" || check.status === "cancelled"
          ? this.theme.fg("dim", check.content)
          : this.theme.fg("text", check.content);
        lines.push(panelLine(`${checkIcon(check.status, this.theme)} ${text}`, innerWidth, border));
      }
      if (this.goal.checks.length > 5) {
        lines.push(panelLine(this.theme.fg("dim", `  +${this.goal.checks.length - 5} more`), innerWidth, border));
      }
    }

    if (this.goal.progressSummary) {
      lines.push(panelLine("", innerWidth, border));
      lines.push(panelLine(this.theme.fg("dim", this.goal.progressSummary), innerWidth, border));
    }

    if (this.goal.tokenBudget !== null) {
      lines.push(panelLine("", innerWidth, border));
      const usage = `${formatTokens(this.goal.tokensUsed)} / ${formatTokens(this.goal.tokenBudget)} tokens`;
      lines.push(panelLine(`${progressBar(this.goal.tokensUsed, this.goal.tokenBudget, this.theme)} ${this.theme.fg("dim", usage)}`, innerWidth, border));
    }

    if (this.goal.blockerAudit) {
      lines.push(panelLine("", innerWidth, border));
      lines.push(panelLine(
        this.theme.fg("error", `Blocker ${this.goal.blockerAudit.count}/3: ${this.goal.blockerAudit.description}`),
        innerWidth,
        border,
      ));
      if (this.goal.blockerAudit.nextInput) {
        lines.push(panelLine(this.theme.fg("dim", `Needed: ${this.goal.blockerAudit.nextInput}`), innerWidth, border));
      }
    }

    lines.push(panelLine("", innerWidth, border));
    lines.push(panelLine(this.theme.fg("dim", actionHint(this.goal.status)), innerWidth, border));
    lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}
}

function currentElapsed(goal: GoalState, activeRunStartedAt: number | undefined): number {
  if (goal.status !== "active" || activeRunStartedAt === undefined) return goal.timeUsedMs;
  return goal.timeUsedMs + Math.max(0, Date.now() - activeRunStartedAt);
}

function styledStatus(status: GoalStatus, theme: Theme): string {
  const label = status.replace("_", " ").toUpperCase();
  if (status === "active") return theme.fg("success", `● ${label}`);
  if (status === "complete") return theme.fg("success", `✓ ${label}`);
  if (status === "paused") return theme.fg("warning", `Ⅱ ${label}`);
  if (status === "budget_limited") return theme.fg("warning", `■ ${label}`);
  return theme.fg("error", `! ${label}`);
}

function checkIcon(status: GoalCheckStatus, theme: Theme): string {
  if (status === "complete") return theme.fg("success", "✓");
  if (status === "in_progress") return theme.fg("accent", "●");
  if (status === "cancelled") return theme.fg("dim", "−");
  return theme.fg("dim", "○");
}

function progressBar(value: number, total: number, theme: Theme): string {
  const ratio = Math.min(1, Math.max(0, value / total));
  const filled = Math.round(ratio * 8);
  return theme.fg(ratio >= 1 ? "warning" : "accent", `${"━".repeat(filled)}${"─".repeat(8 - filled)}`);
}

function panelLine(content: string, width: number, border: (value: string) => string): string {
  const clipped = truncateToWidth(content, width, "…");
  return `${border("│")} ${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))} ${border("│")}`;
}

function actionHint(status: GoalStatus): string {
  const toggle = status === "active"
    ? "p pause"
    : status === "paused" || status === "blocked" || status === "usage_limited"
      ? "r resume"
      : undefined;
  return ["e edit", toggle, "c clear", "esc close"].filter(Boolean).join("  ·  ");
}
