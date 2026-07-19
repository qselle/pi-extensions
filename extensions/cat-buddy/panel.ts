import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

export type AnimationMode = "smart" | "working" | "always" | "static";
export type CatAction =
  | { type: "visibility"; visible: boolean }
  | { type: "mode"; mode: AnimationMode };

export type CatCommand =
  | { type: "panel" }
  | { type: "status" }
  | CatAction
  | { type: "invalid" };

interface CatPanelOption {
  label: string;
  description: string;
  action: CatAction;
  active?: boolean;
}

const MODE_OPTIONS: Array<{
  mode: AnimationMode;
  label: string;
  description: string;
}> = [
  { mode: "smart", label: "Smart", description: "Occasional movement that reacts while Pi works" },
  { mode: "always", label: "Always", description: "Animate continuously" },
  { mode: "working", label: "Working", description: "Animate only while Pi is working" },
  { mode: "static", label: "Static", description: "Stay in the neutral pose" },
];

export function parseCatCommand(input: string): CatCommand {
  const command = input.trim().toLowerCase();
  if (!command) return { type: "panel" };
  if (command === "status") return { type: "status" };
  if (command === "show" || command === "on") return { type: "visibility", visible: true };
  if (command === "hide" || command === "off") return { type: "visibility", visible: false };
  if (command === "smart" || command === "always" || command === "working" || command === "static") {
    return { type: "mode", mode: command };
  }
  return { type: "invalid" };
}

export class CatPanel implements Component {
  private selected = 0;

  constructor(
    private readonly visible: boolean,
    private readonly mode: AnimationMode,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly onAction: (action: CatAction) => void,
  ) {}

  render(width: number): string[] {
    const options = this.options();
    const compact = width < 52;
    const lines = [
      panelHeader("Cat companion", width, this.theme),
      panelLine(
        `${this.theme.fg(this.visible ? "success" : "muted", this.visible ? "● visible" : "○ hidden")}`
          + this.theme.fg("dim", ` · ${this.mode} animation`),
        width,
        this.theme,
      ),
      panelLine("", width, this.theme),
      panelLine(this.theme.fg("muted", "Controls"), width, this.theme),
    ];

    options.forEach((option, index) => {
      const cursor = index === this.selected ? this.theme.fg("accent", ">") : " ";
      const state = option.active === undefined
        ? this.theme.fg("accent", "◆")
        : option.active
          ? this.theme.fg("success", "●")
          : this.theme.fg("dim", "○");
      const label = index === this.selected ? this.theme.bold(option.label) : option.label;
      const description = compact ? "" : this.theme.fg("dim", `  ${option.description}`);
      lines.push(panelLine(`${cursor} ${state} ${label}${description}`, width, this.theme));
    });

    lines.push(
      panelLine("", width, this.theme),
      panelLine(this.theme.fg("dim", "↑↓ navigate · enter select · esc close"), width, this.theme),
      panelFooter(width, this.theme),
    );
    return lines;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const options = this.options();
    if (matchesKey(data, "escape") || data === "q") {
      this.done();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = (this.selected - 1 + options.length) % options.length;
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selected = (this.selected + 1) % options.length;
      return;
    }
    if (matchesKey(data, "enter") || data === " ") {
      this.onAction(options[this.selected]!.action);
      this.done();
    }
  }

  private options(): CatPanelOption[] {
    return [
      {
        label: this.visible ? "Hide cat" : "Show cat",
        description: this.visible ? "Remove the companion from the input bar" : "Return the companion to the input bar",
        action: { type: "visibility", visible: !this.visible },
      },
      ...MODE_OPTIONS.map((option) => ({
        label: option.label,
        description: option.description,
        action: { type: "mode", mode: option.mode } as CatAction,
        active: this.mode === option.mode,
      })),
    ];
  }
}

function panelHeader(title: string, width: number, theme: Theme): string {
  if (width <= 0) return "";
  if (width === 1) return theme.fg("border", "─");
  const label = ` ${title} `;
  if (width < visibleWidth(label) + 3) {
    return theme.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`);
  }
  const remainder = width - visibleWidth(label) - 3;
  return theme.fg("border", `╭─${label}${"─".repeat(remainder)}╮`);
}

function panelLine(content: string, width: number, theme: Theme): string {
  if (width <= 0) return "";
  if (width === 1) return theme.fg("border", "│");
  const innerWidth = Math.max(0, width - 2);
  const clipped = truncateToWidth(content, innerWidth, "…");
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
  return `${theme.fg("border", "│")}${clipped}${padding}${theme.fg("border", "│")}`;
}

function panelFooter(width: number, theme: Theme): string {
  if (width <= 0) return "";
  if (width === 1) return theme.fg("border", "─");
  return theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}
