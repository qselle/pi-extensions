import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { rankHistory, type HistoryItem, type RankedHistoryItem } from "./history.ts";

const MAX_VISIBLE_RESULTS = 10;

export class HistoryPicker implements Component, Focusable {
  private readonly input = new Input();
  private matches: RankedHistoryItem[] = [];
  private selectedIndex = 0;
  private readonly maxVisible: number;
  private _focused = false;

  constructor(
    private readonly items: readonly HistoryItem[],
    initialQuery: string,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly tui: TUI,
    private readonly done: (result: string | null) => void,
  ) {
    this.input.setValue(initialQuery);
    const rows = (tui as TUI & { terminal?: { rows?: number } }).terminal?.rows ?? 24;
    this.maxVisible = Math.max(3, Math.min(MAX_VISIBLE_RESULTS, Math.floor(rows * 0.7) - 6));
    this.refresh();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  getQuery(): string {
    return this.input.getValue();
  }

  getMatches(): readonly RankedHistoryItem[] {
    return this.matches;
  }

  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.matches[this.selectedIndex];
      if (selected) this.done(selected.text);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "ctrl+p")) {
      this.moveSelection(-1);
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.down")
      || matchesKey(data, "ctrl+n")
      || matchesKey(data, "ctrl+r")
    ) {
      this.moveSelection(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-this.maxVisible);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(this.maxVisible);
      return;
    }

    const previousQuery = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== previousQuery) {
      this.selectedIndex = 0;
      this.refresh();
    } else {
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (safeWidth < 4) return [truncateToWidth("History", safeWidth, "")];

    const innerWidth = safeWidth - 2;
    const count = this.matches.length === this.items.length
      ? `${this.items.length}`
      : `${this.matches.length}/${this.items.length}`;
    const lines = [this.topBorder(safeWidth, ` History search · ${count} `)];
    const queryWidth = Math.max(1, innerWidth - 3);
    const queryLine = this.input.render(queryWidth)[0] ?? "";
    lines.push(this.frameLine(`${this.theme.fg("accent", "? ")}${queryLine}`, safeWidth));
    lines.push(this.middleBorder(safeWidth));

    if (this.matches.length === 0) {
      lines.push(this.frameLine(this.theme.fg("muted", "  No matching history"), safeWidth));
    } else {
      const start = Math.max(
        0,
        Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.matches.length - this.maxVisible),
      );
      const end = Math.min(start + this.maxVisible, this.matches.length);
      for (let index = start; index < end; index++) {
        const match = this.matches[index]!;
        const selected = index === this.selectedIndex;
        const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
        const text = highlightMatch(match, this.theme, selected);
        lines.push(this.frameLine(`${prefix}${text}`, safeWidth));
      }
      if (start > 0 || end < this.matches.length) {
        lines.push(this.frameLine(this.theme.fg("dim", `  ${this.selectedIndex + 1}/${this.matches.length}`), safeWidth));
      }
    }

    lines.push(this.middleBorder(safeWidth));
    lines.push(this.frameLine(this.theme.fg("dim", " ↑↓/Ctrl+R navigate · Enter use · Esc cancel"), safeWidth));
    lines.push(this.bottomBorder(safeWidth));
    return lines.map((line) => truncateToWidth(line, safeWidth, ""));
  }

  invalidate(): void {
    this.input.invalidate();
  }

  private refresh(): void {
    this.matches = rankHistory(this.items, this.input.getValue());
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.matches.length - 1));
    this.requestRender();
  }

  private moveSelection(delta: number): void {
    if (this.matches.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta) % this.matches.length;
    if (this.selectedIndex < 0) this.selectedIndex += this.matches.length;
    this.requestRender();
  }

  private requestRender(): void {
    this.tui.requestRender();
  }

  private frameLine(content: string, width: number): string {
    const innerWidth = Math.max(0, width - 2);
    const clipped = truncateToWidth(content, innerWidth, "");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    return `${this.theme.fg("border", "│")}${clipped}${padding}${this.theme.fg("border", "│")}`;
  }

  private topBorder(width: number, label: string): string {
    const innerWidth = Math.max(0, width - 2);
    const clipped = truncateToWidth(this.theme.bold(label), innerWidth, "");
    const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    return this.theme.fg("border", `╭${clipped}${fill}╮`);
  }

  private middleBorder(width: number): string {
    return this.theme.fg("border", `├${"─".repeat(Math.max(0, width - 2))}┤`);
  }

  private bottomBorder(width: number): string {
    return this.theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
  }
}

function highlightMatch(match: RankedHistoryItem, theme: Theme, selected: boolean): string {
  const positions = new Set(match.positions);
  return Array.from(match.display).map((character, index) => {
    if (positions.has(index)) return theme.fg("accent", theme.bold(character));
    return selected ? theme.bold(character) : character;
  }).join("");
}
