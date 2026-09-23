import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI, type KeybindingsManager } from "@earendil-works/pi-tui";
import { keyLabel } from "../../lib/keys.ts";
import { searchCommands, type PaletteCommand } from "./catalog.ts";

export class CommandPicker implements Component, Focusable {
  private input = new Input();
  private matches: PaletteCommand[] = [];
  private selected = 0;
  private _focused = false;

  constructor(private commands: readonly PaletteCommand[], query: string, private theme: Theme,
    private keys: KeybindingsManager, private tui: TUI, private done: (command: string | null) => void) {
    // Pasting through the public input API puts the cursor after the seed, even
    // when the user's end-of-line key is rebound. setValue leaves it at zero.
    const seed = query.slice(0, 160).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    this.input.handleInput(`\x1b[200~${seed}\x1b[201~`);
    this.refresh();
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }
  private count(): number { return Math.max(1, Math.min(10, Math.floor((this.tui.terminal.rows * 0.8 - 8) / 2))); }
  private refresh(): void { this.matches = searchCommands(this.commands, this.input.getValue()); this.selected = 0; }

  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.cancel")) { this.done(null); return; }
    if (this.keys.matches(data, "tui.select.confirm")) {
      const command = this.matches[this.selected];
      if (command) this.done(command.name);
      return;
    }
    let delta = 0;
    if (this.keys.matches(data, "tui.select.up")) delta = -1;
    else if (this.keys.matches(data, "tui.select.down")) delta = 1;
    else if (this.keys.matches(data, "tui.select.pageUp")) delta = -this.count();
    else if (this.keys.matches(data, "tui.select.pageDown")) delta = this.count();
    if (delta) this.selected = Math.max(0, Math.min(this.matches.length - 1, this.selected + delta));
    else {
      const before = this.input.getValue();
      this.input.handleInput(data);
      // A pasted document must not turn every keypress into a large fuzzy query.
      if (this.input.getValue().length > 160) this.input.setValue(this.input.getValue().slice(0, 160));
      if (this.input.getValue() !== before) this.refresh();
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    if (width < 4) return [truncateToWidth("Commands", width, "")];
    const inner = width - 2;
    const frame = (text: string) => {
      const clipped = truncateToWidth(text, inner, "");
      return this.theme.fg("border", "│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + this.theme.fg("border", "│");
    };
    const edge = (left: string, label: string, right: string) => {
      const clipped = truncateToWidth(label, inner, "");
      return this.theme.fg("border", left + clipped + "─".repeat(Math.max(0, inner - visibleWidth(clipped))) + right);
    };
    const lines = [edge("╭", ` Commands · ${this.matches.length}/${this.commands.length} `, "╮"),
      frame(this.input.render(inner)[0] ?? ""), edge("├", "", "┤")];
    const count = this.count();
    const start = Math.max(0, Math.min(this.selected - Math.floor(count / 2), this.matches.length - count));
    for (let index = start; index < Math.min(start + count, this.matches.length); index++) {
      const command = this.matches[index]!;
      const selected = index === this.selected;
      lines.push(frame((selected ? this.theme.fg("accent", "› ") : "  ") + this.theme.fg(selected ? "accent" : "text", `/${command.name}`)
        + this.theme.fg("dim", ` · ${command.source} / ${command.scope}`)));
      lines.push(frame(this.theme.fg("muted", `  ${command.description || "No description provided"}`)));
    }
    if (!this.matches.length) lines.push(frame(this.theme.fg("muted", "  No matching commands")));
    const enter = keyLabel(this.keys, "tui.select.confirm", "Enter");
    const esc = keyLabel(this.keys, "tui.select.cancel", "Esc");
    const navigation = `${keyLabel(this.keys, "tui.select.up", "↑")}${keyLabel(this.keys, "tui.select.down", "↓")}`;
    lines.push(edge("├", "", "┤"), frame(this.theme.fg("dim", ` ${navigation} select · ${enter} insert · ${esc} close`)), edge("╰", "", "╯"));
    return lines;
  }

  invalidate(): void { this.input.invalidate(); }
}
