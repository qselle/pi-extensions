import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AgentTranscript } from "./coordinator.ts";

export class LiveTranscriptViewer implements Component {
  private scroll = 0;
  private maxScroll = 0;
  private followTail = true;
  private cachedWidth = 0;
  private cachedLines: string[] = [];

  constructor(
    private readonly load: () => AgentTranscript,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly tui: TUI,
    private readonly done: () => void,
  ) {}

  refresh(): void {
    this.cachedWidth = 0;
  }

  handleInput(data: string): void {
    const page = Math.max(5, this.viewportHeight() - 4);
    if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
      this.done();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.followTail = false;
      this.scroll = Math.max(0, this.scroll - 1);
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.scroll = Math.min(this.maxScroll, this.scroll + 1);
      this.followTail = this.scroll >= this.maxScroll;
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.followTail = false;
      this.scroll = Math.max(0, this.scroll - page);
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.scroll = Math.min(this.maxScroll, this.scroll + page);
      this.followTail = this.scroll >= this.maxScroll;
    } else if (matchesKey(data, Key.home)) {
      this.followTail = false;
      this.scroll = 0;
    } else if (matchesKey(data, Key.end)) {
      this.followTail = true;
      this.scroll = this.maxScroll;
    } else {
      return;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const height = this.viewportHeight();
    const bodyHeight = Math.max(1, height - 2);
    const transcript = this.load();
    const body = this.lines(safeWidth, transcript);
    this.maxScroll = Math.max(0, body.length - bodyHeight);
    this.scroll = this.followTail ? this.maxScroll : Math.min(this.scroll, this.maxScroll);
    const percent = this.maxScroll === 0 ? 100 : Math.round((this.scroll / this.maxScroll) * 100);
    const runtime = `${transcript.agent.model ?? "inherited model"}${transcript.agent.thinking ? `:${transcript.agent.thinking}` : ""}`;
    const header = truncateToWidth(
      `${this.theme.fg("accent", this.theme.bold(`Subagent · ${transcript.agent.name}`))} ${this.theme.fg("dim", `· ${transcript.agent.status} · ${runtime}`)}`,
      safeWidth,
      "…",
    );
    const visible = body.slice(this.scroll, this.scroll + bodyHeight).map((line) => truncateToWidth(line, safeWidth, ""));
    while (visible.length < bodyHeight) visible.push("");
    const footer = truncateToWidth(
      this.theme.fg("dim", `↑↓/PgUp/PgDn scroll · Home/End follow · q/Esc close · ${percent}%`),
      safeWidth,
      "",
    );
    return [header, ...visible, footer];
  }

  invalidate(): void {
    this.refresh();
  }

  private lines(width: number, transcript: AgentTranscript): string[] {
    if (this.cachedWidth === width) return this.cachedLines;
    const lines: string[] = [];
    appendSection(lines, section("›", "Task", "accent", transcript.agent.task, "text", width, this.theme));
    for (const entry of transcript.entries) {
      const rendered = renderEntry(entry as any, width, this.theme);
      if (rendered.length > 0) appendSection(lines, rendered);
    }
    if (transcript.agent.error) {
      appendSection(lines, section("×", "Error", "error", transcript.agent.error, "error", width, this.theme));
    }
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private viewportHeight(): number {
    const rows = (this.tui as TUI & { terminal?: { rows?: number } }).terminal?.rows ?? process.stdout.rows ?? 24;
    return Math.max(8, Math.floor(rows * 0.86) - 2);
  }
}

function renderEntry(entry: any, width: number, theme: Theme): string[] {
  if (entry?.type !== "message") return [];
  const message = entry.message ?? {};
  if (message.role === "assistant") {
    const lines: string[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if (part?.type === "thinking" && part.thinking) {
        appendSection(lines, section("·", "Thinking", "dim", part.thinking, "dim", width, theme));
      } else if (part?.type === "text" && part.text) {
        appendSection(lines, section("●", "Agent", "success", part.text, "text", width, theme));
      } else if (part?.type === "toolCall") {
        appendSection(lines, section("◆", `Tool · ${part.name ?? "unknown"}`, "accent", formatArguments(part.arguments), "muted", width, theme));
      }
    }
    return lines;
  }
  if (message.role === "toolResult") {
    const failed = Boolean(message.isError);
    return section(
      failed ? "×" : "✓",
      `${failed ? "Tool failed" : "Tool result"} · ${message.toolName ?? "unknown"}`,
      failed ? "error" : "success",
      messageText(message.content),
      failed ? "error" : "muted",
      width,
      theme,
    );
  }
  if (message.role === "bashExecution") {
    return section("$", "Shell", "accent", `${message.command ?? ""}\n${message.output ?? ""}`, "muted", width, theme);
  }
  if (message.role === "user") {
    return section("›", "Follow-up", "accent", messageText(message.content), "text", width, theme);
  }
  return [];
}

function section(
  symbol: string,
  label: string,
  labelColor: any,
  body: string,
  bodyColor: any,
  width: number,
  theme: Theme,
): string[] {
  const header = truncateToWidth(`${theme.fg(labelColor, symbol)} ${theme.fg(labelColor, label)}`, width, "…");
  const indent = "  ";
  const available = Math.max(1, width - visibleWidth(indent));
  const rows = wrapTextWithAnsi(clean(body) || "(empty)", available);
  return [header, ...rows.map((row) => `${indent}${theme.fg(bodyColor, row)}`)];
}

function appendSection(lines: string[], sectionLines: string[]): void {
  if (sectionLines.length === 0) return;
  if (lines.length > 0) lines.push("");
  lines.push(...sectionLines);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string"))
    .map((part) => part.text)
    .join("\n");
}

function formatArguments(value: unknown): string {
  if (!value || typeof value !== "object") return "(no arguments)";
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 1_200 ? `${text.slice(0, 1_200)}\n… arguments truncated` : text;
  } catch {
    return String(value);
  }
}

function clean(text: string): string {
  return String(text)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
