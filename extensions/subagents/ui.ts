import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { boundedText, isActive, type AgentSnapshot } from "./coordinator.ts";

const MAX_OVERLAY_AGENTS = 3;
const AGENT_ROWS = 3;

export interface SubagentToolDetails {
  action: string;
  agents: AgentSnapshot[];
  timedOut?: boolean;
  interrupted?: boolean;
  alreadyReportedIds?: string[];
}

export function renderSubagentsOverlay(
  agents: readonly AgentSnapshot[],
  width: number,
  maxHeight: number,
  theme: Theme,
): string[] {
  if (width < 20 || maxHeight < AGENT_ROWS || agents.length === 0) return [];
  const capacity = Math.min(MAX_OVERLAY_AGENTS, Math.floor(maxHeight / AGENT_ROWS));
  const shown = agents.slice(0, capacity);
  const lines = shown.flatMap((agent) => overlayAgent(agent, width, theme));
  const hidden = agents.length - shown.length;
  if (hidden > 0 && lines.length < maxHeight) lines.push(theme.fg("dim", `… ${hidden} more · /subagents`));
  return lines.slice(0, maxHeight).map((line) => truncateToWidth(line, width, ""));
}

export function renderSubagentCall(args: any, theme: Theme): Component {
  const action = String(args.action ?? "...");
  const subject = action === "spawn"
    ? `${String(args.name ?? "unnamed")} · ${compact(String(args.task ?? ""), 70)}`
    : action === "wait"
      ? `${Array.isArray(args.agent_names) && args.agent_names.length ? args.agent_names.join(", ") : "running agents"}`
      : action === "list"
        ? "current session"
        : `${String(args.agent_name ?? "unknown")}`;
  return new Text(
    `${theme.fg("toolTitle", theme.bold(`subagents ${action}`))}\n  ${theme.fg("dim", subject)}`,
    0,
    0,
  );
}

export function renderSubagentResult(
  result: any,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Theme,
): Component {
  const details = result.details as SubagentToolDetails | undefined;
  if (options.isPartial) return new Text(theme.fg("warning", "Subagent action running…"), 0, 0);
  if (!details?.agents.length) {
    return new Text(textResult(result) || theme.fg("muted", "No subagents."), 0, 0);
  }

  const hidden = new Set(details.alreadyReportedIds ?? []);
  const visible = details.agents.filter((agent) => !hidden.has(agent.id));
  if (details.action === "wait" && visible.length === 0) return new Container();
  const container = new Container();
  const suffix = details.interrupted ? " · interrupted" : details.timedOut ? " · timed out" : "";
  container.addChild(new Text(theme.fg("toolTitle", theme.bold(`${details.action}${suffix}`)), 0, 0));
  for (const agent of visible) {
    container.addChild(new Text(agentHeader(agent, theme), 0, 0));
    container.addChild(new Text(`${theme.fg("muted", "  task  ")}${theme.fg("dim", compact(agent.task, 180))}`, 0, 0));
    if (agent.error) container.addChild(new Text(`${theme.fg("error", "  error ")}${theme.fg("error", compact(agent.error, 220))}`, 0, 0));
    if (agent.output && !isActive(agent)) {
      if (options.expanded) {
        container.addChild(new Markdown(agent.output, 2, 0, getMarkdownTheme()));
      } else {
        container.addChild(new Text(`${theme.fg(agent.status === "failed" ? "error" : "success", "  result ")}${compact(agent.output, 180)}`, 0, 0));
      }
    }
    const usage = usageText(agent);
    if (usage) container.addChild(new Text(`${theme.fg("muted", "  usage ")}${theme.fg("dim", usage)}`, 0, 0));
  }
  return container;
}

export function renderCompletionMessage(agent: AgentSnapshot, expanded: boolean, theme: Theme): Component {
  const container = new Container();
  container.addChild(new Text(
    `${theme.fg(agent.status === "failed" ? "error" : "success", agent.status === "failed" ? "×" : "✓")} ${theme.bold(agent.name)} ${theme.fg("muted", agent.status)}`,
    0,
    0,
  ));
  container.addChild(new Text(`${theme.fg("muted", "task   ")}${theme.fg("dim", compact(agent.task, 200))}`, 0, 0));
  if (agent.error) container.addChild(new Text(`${theme.fg("error", "error  ")}${theme.fg("error", compact(agent.error, 240))}`, 0, 0));
  if (agent.output) {
    if (expanded) container.addChild(new Markdown(agent.output, 0, 0, getMarkdownTheme()));
    else container.addChild(new Text(`${theme.fg(agent.status === "failed" ? "error" : "success", "result ")}${compact(agent.output, 200)}`, 0, 0));
  }
  const usage = usageText(agent);
  if (usage) container.addChild(new Text(`${theme.fg("muted", "usage  ")}${theme.fg("dim", usage)}`, 0, 0));
  return container;
}

export class SubagentPanel implements Component {
  constructor(
    private readonly agent: AgentSnapshot,
    private readonly theme: Theme,
    private readonly done: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) this.done();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const inner = Math.max(1, safeWidth - 4);
    const title = ` Subagent · ${this.agent.name} `;
    const lines = [
      frameTop(title, safeWidth, this.theme),
      frameLine(agentHeader(this.agent, this.theme), safeWidth, this.theme),
      frameLine(`context  ${this.agent.contextMode}`, safeWidth, this.theme),
      frameLine(`model    ${runtimeLabel(this.agent)}`, safeWidth, this.theme),
      frameLine(`cwd      ${this.agent.cwd}`, safeWidth, this.theme),
      frameLine(`task     ${this.agent.task}`, safeWidth, this.theme),
    ];
    if (this.agent.activity.length > 0) lines.push(frameLine(`activity ${this.agent.activity.at(-1)}`, safeWidth, this.theme));
    if (this.agent.error) lines.push(frameLine(`error    ${this.agent.error}`, safeWidth, this.theme));
    if (this.agent.output) {
      lines.push(frameLine("result", safeWidth, this.theme));
      for (const line of wrapTextWithAnsi(boundedText(this.agent.output, 8 * 1024), inner)) {
        lines.push(frameLine(line, safeWidth, this.theme));
      }
    }
    const usage = usageText(this.agent);
    if (usage) lines.push(frameLine(`usage    ${usage}`, safeWidth, this.theme));
    lines.push(frameLine("Enter/Esc close", safeWidth, this.theme));
    lines.push(this.theme.fg("border", `╰${"─".repeat(Math.max(0, safeWidth - 2))}╯`));
    return lines.map((line) => truncateToWidth(line, safeWidth, ""));
  }

  invalidate(): void {}
}

export function usageText(agent: AgentSnapshot): string {
  const pieces: string[] = [];
  if (agent.usage.turns) pieces.push(`${agent.usage.turns} ${agent.usage.turns === 1 ? "turn" : "turns"}`);
  if (agent.usage.input) pieces.push(`↑${tokens(agent.usage.input)}`);
  if (agent.usage.output) pieces.push(`↓${tokens(agent.usage.output)}`);
  if (agent.usage.cacheRead) pieces.push(`R${tokens(agent.usage.cacheRead)}`);
  if (agent.usage.cacheWrite) pieces.push(`W${tokens(agent.usage.cacheWrite)}`);
  if (agent.usage.cost) pieces.push(`$${agent.usage.cost.toFixed(4)}`);
  if (agent.model) pieces.push(runtimeLabel(agent));
  return pieces.join(" · ");
}

function overlayAgent(agent: AgentSnapshot, width: number, theme: Theme): string[] {
  const symbol = theme.fg(statusColor(agent.status), statusSymbol(agent.status));
  const usage = theme.fg("muted", `${tokens(totalTokens(agent))} tok`);
  const nameWidth = Math.max(6, width - visibleWidth(symbol) - visibleWidth(usage) - 3);
  const name = truncateToWidth(agent.name, nameWidth, "…");
  const identity = `${symbol} ${theme.bold(name)}`;
  const gap = " ".repeat(Math.max(1, width - visibleWidth(identity) - visibleWidth(usage)));
  const task = truncateToWidth(compact(agent.task, 200), Math.max(1, width - 2), "…");
  const latest = compact(agent.activity.at(-1) || (agent.status === "starting" ? "starting" : "working"), 160);
  const runtime = runtimeLabel(agent);
  const activity = truncateToWidth([runtime, latest].filter(Boolean).join(" · "), Math.max(1, width - 4), "…");
  return [
    `${identity}${gap}${usage}`,
    `  ${theme.fg("text", task)}`,
    `${theme.fg("dim", "  ↳ ")}${theme.fg("dim", activity)}`,
  ];
}

function agentHeader(agent: AgentSnapshot, theme: Theme): string {
  return `${theme.fg(statusColor(agent.status), statusSymbol(agent.status))} ${theme.bold(agent.name)} · ${theme.fg("muted", `${agent.contextMode} · ${agent.status}`)}`;
}

function statusSymbol(status: AgentSnapshot["status"]): string {
  if (status === "starting" || status === "running") return "●";
  if (status === "completed") return "✓";
  if (status === "failed") return "×";
  return "■";
}

function statusColor(status: AgentSnapshot["status"]): any {
  if (status === "starting" || status === "running") return "accent";
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  return "muted";
}

function runtimeLabel(agent: AgentSnapshot): string {
  if (!agent.model) return agent.thinking ? `inherited:${agent.thinking}` : "inherited runtime";
  return `${agent.model}${agent.thinking ? `:${agent.thinking}` : ""}`;
}

function totalTokens(agent: AgentSnapshot): number {
  return agent.usage.input + agent.usage.output + agent.usage.cacheRead + agent.usage.cacheWrite;
}

function tokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value / 1_000)}k`;
}

function compact(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function textResult(result: any): string {
  const part = result?.content?.find?.((item: any) => item?.type === "text");
  return part?.text ?? "";
}

function frameTop(title: string, width: number, theme: Theme): string {
  const clipped = truncateToWidth(title, Math.max(1, width - 2), "…");
  return theme.fg("border", `╭${clipped}${"─".repeat(Math.max(0, width - visibleWidth(clipped) - 2))}╮`);
}

function frameLine(content: string, width: number, theme: Theme): string {
  const inner = Math.max(0, width - 4);
  const clipped = truncateToWidth(content, inner, "…");
  return `${theme.fg("border", "│ ")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${theme.fg("border", " │")}`;
}
