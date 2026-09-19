import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { keyLabel } from "../keys.ts";
import type { TranscriptBlock } from "./model.ts";
import { TranscriptSearch, type SearchMatch } from "./search.ts";

interface RenderedBlock { block: TranscriptBlock; width: number; lines: string[]; search?: TranscriptSearch }

export const TRANSCRIPT_OVERLAY_OPTIONS = {
  anchor: "center", width: "100%", maxHeight: "90%",
  margin: { top: 1, bottom: 1, left: 0, right: 0 },
} as const;

function logicalLines(block: TranscriptBlock, rows: string[]): string[] {
  if (!block.markdown) return block.body.split(/\r\n|\r|\n/);
  const source = block.body.split("\n");
  let width = 80;
  for (const line of source) width = Math.max(width, visibleWidth(line) + 16);
  // Keep the second, unwrapped Markdown render bounded. Tables or layouts that
  // cannot project exactly retain native row search instead of approximate jumps.
  if (width > 4096 || width * (source.length + 1) + block.body.length > 1_000_000) return rows;
  return new Markdown(block.body, 0, 0, getMarkdownTheme()).render(width);
}

export class TranscriptView implements Component, Focusable {
  private input = new Input();
  private searching = false;
  private previousQuery = "";
  private query = "";
  private showThinking = false;
  private follow = true;
  private scroll = 0;
  private maxScroll = 0;
  private matches: SearchMatch[] = [];
  private matchIndex = -1;
  private blocks: TranscriptBlock[] = [];
  private cache = new Map<string, RenderedBlock>();
  private lines: string[] = [];
  private width = 0;
  private dirty = true;
  private focusedValue = false;
  private closed = false;
  private jumpToMatch = false;

  constructor(
    private readonly load: () => TranscriptBlock[],
    private readonly scope: string,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly tui: TUI,
    private readonly done: () => void,
    initialQuery = "",
    private readonly presentation: "live" | "snapshot" = "live",
  ) {
    this.follow = presentation === "live";
    this.query = initialQuery;
    this.input.setValue(initialQuery);
    if (initialQuery) { this.follow = false; this.jumpToMatch = true; }
    this.refresh();
  }

  get focused(): boolean { return this.focusedValue; }
  set focused(value: boolean) { this.focusedValue = value; this.input.focused = value && this.searching; }

  refresh(): void {
    if (this.closed) return;
    this.blocks = this.load();
    this.dirty = true;
    this.tui.requestRender();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    this.done();
  }

  handleInput(data: string): void {
    if (this.searching) {
      if (this.keys.matches(data, "tui.select.cancel")) {
        this.query = this.previousQuery;
        this.input.setValue(this.query);
        this.searching = false;
        this.input.focused = false;
        this.dirty = true;
        this.jumpToMatch = true;
      } else if (this.keys.matches(data, "tui.select.confirm")) {
        this.searching = false;
        this.input.focused = false;
      } else {
        this.input.handleInput(data);
        const query = this.input.getValue();
        if (query !== this.query) {
          this.query = query;
          this.matchIndex = -1;
          this.dirty = true;
          this.follow = false;
          this.jumpToMatch = true;
        }
      }
    } else if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
      this.close();
      return;
    } else if (matchesKey(data, "/")) {
      this.previousQuery = this.query;
      this.searching = true;
      this.input.focused = this.focusedValue;
    } else if (this.presentation === "live" && matchesKey(data, "t")) {
      this.showThinking = !this.showThinking;
      this.dirty = true;
      this.matchIndex = -1;
    } else if (matchesKey(data, "n") || data === "N") {
      if (this.matches.length) {
        this.matchIndex = (this.matchIndex + (data === "N" ? -1 : 1) + this.matches.length) % this.matches.length;
        this.scroll = Math.min(this.maxScroll, this.matches[this.matchIndex]!.firstLine);
        this.follow = false;
      }
    } else if (matchesKey(data, "home")) { this.scroll = 0; this.follow = false; }
    else if (matchesKey(data, "end")) { this.scroll = this.maxScroll; this.follow = this.presentation === "live"; }
    else {
      const page = Math.max(1, this.height() - 2);
      let delta = 0;
      if (this.keys.matches(data, "tui.select.up")) delta = -1;
      else if (this.keys.matches(data, "tui.select.down")) delta = 1;
      else if (this.keys.matches(data, "tui.select.pageUp")) delta = -page;
      else if (this.keys.matches(data, "tui.select.pageDown")) delta = page;
      else return;
      this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + delta));
      this.follow = false;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0 || this.closed) return [];
    const height = this.height();
    const contentWidth = Math.max(1, width - 4);
    if (this.dirty || this.width !== contentWidth) {
      if (this.width !== contentWidth && this.matchIndex >= 0) this.jumpToMatch = true;
      this.rebuild(contentWidth);
    }
    const bodyHeight = Math.max(0, height - 2);
    this.maxScroll = Math.max(0, this.lines.length - bodyHeight);
    this.scroll = this.follow ? this.maxScroll : Math.min(this.scroll, this.maxScroll);
    const count = this.query ? ` · ${this.matches.length ? this.matchIndex + 1 : 0}/${this.matches.length} matches` : "";
    const header = this.theme.fg("accent", this.theme.bold(this.presentation === "snapshot" ? this.scope : `Transcript · ${this.scope}`))
      + this.theme.fg("muted", `${this.follow ? " · following" : ""}${count}`);
    if (height === 1) return [this.frameEdge(header, width, "top")];
    const rows = this.lines.slice(this.scroll, this.scroll + bodyHeight).map((line, offset) => {
      const match = this.matches[this.matchIndex];
      const clipped = truncateToWidth(line, contentWidth, "");
      const padded = clipped + " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
      return this.query && match && match.firstLine <= this.scroll + offset && match.lastLine >= this.scroll + offset
        ? this.theme.bg("selectedBg", padded) : padded;
    });
    while (rows.length < bodyHeight) rows.push("");
    const footer = this.searching
      ? `/ ${this.input.render(Math.max(1, contentWidth - 2))[0] ?? ""}`
      : this.theme.fg("dim", this.navigationHints(contentWidth));
    const border = (text: string) => this.theme.fg("borderMuted", text);
    return [this.frameEdge(header, width, "top"), ...rows.map((line) => width >= 5
      ? `${border("│ ")}${line || " ".repeat(contentWidth)}${border(" │")}`
      : border(width === 1 ? "│" : `│${" ".repeat(width - 2)}│`)), this.frameEdge(footer, width, "bottom")]
      .map((line) => truncateToWidth(line, width, ""));
  }

  private navigationHints(width: number): string {
    const close = `q/${keyLabel(this.keys, "tui.select.cancel", "Esc")} close`;
    const hints = [
      visibleWidth(close) <= width ? close : "q close", "/ search",
      `${keyLabel(this.keys, "tui.select.up", "↑")}${keyLabel(this.keys, "tui.select.down", "↓")} scroll`,
      "n/N matches",
      ...(this.presentation === "snapshot" ? ["End bottom"] : [`t thinking ${this.showThinking ? "on" : "off"}`, "End follow"]),
      `${keyLabel(this.keys, "tui.select.pageUp", "PgUp")}/${keyLabel(this.keys, "tui.select.pageDown", "PgDn")} page`,
    ];
    let text = "";
    for (const hint of hints) {
      const next = text ? `${text} · ${hint}` : hint;
      if (visibleWidth(next) <= width) text = next;
    }
    return text || truncateToWidth("q close", width, "");
  }

  private frameEdge(text: string, width: number, edge: "top" | "bottom"): string {
    const border = (value: string) => this.theme.fg("borderMuted", value);
    if (width === 1) return border("│");
    const label = width > 4 ? ` ${truncateToWidth(text, width - 4, "")} ` : "";
    return border(edge === "top" ? "╭" : "╰") + label
      + border("─".repeat(Math.max(0, width - visibleWidth(label) - 2)) + (edge === "top" ? "╮" : "╯"));
  }

  invalidate(): void { this.cache.clear(); this.dirty = true; this.input.invalidate(); }

  private height(): number {
    return Math.max(1, Math.floor((this.tui.terminal?.rows ?? 24) * 0.9) - 2);
  }

  private rebuild(width: number): void {
    const lines: string[] = [];
    const matches: SearchMatch[] = [];
    const retained = new Set<string>();
    for (const block of this.blocks) {
      if (block.kind === "thinking" && !this.showThinking) continue;
      retained.add(block.id);
      let cached = this.cache.get(block.id);
      if (!cached || cached.width !== width || cached.block.body !== block.body || cached.block.label !== block.label || cached.block.failed !== block.failed || cached.block.markdown !== block.markdown || cached.block.kind !== block.kind || cached.block.labelColor !== block.labelColor) {
        const color = block.labelColor ?? (block.failed ? "error" : block.kind === "user" ? "accent" : block.kind === "thinking" ? "dim" : "muted");
        const body = block.markdown
          ? new Markdown(block.body, 0, 0, getMarkdownTheme()).render(width)
          : wrapTextWithAnsi(block.body, width);
        cached = { block, width, lines: [this.theme.fg(color, this.theme.bold(block.label)), ...body] };
        this.cache.set(block.id, cached);
      }
      if (lines.length) lines.push("");
      if (this.query.trim()) {
        cached.search ??= new TranscriptSearch(cached.lines, [block.label, ...logicalLines(block, cached.lines.slice(1))], block.markdown);
        const offset = lines.length;
        for (const match of cached.search.find(this.query)) matches.push({ firstLine: match.firstLine + offset, lastLine: match.lastLine + offset });
      }
      // Avoid spread argument limits on large tool output.
      for (const line of cached.lines) lines.push(line);
    }
    for (const key of this.cache.keys()) if (!retained.has(key)) this.cache.delete(key);
    if (!lines.length) lines.push(this.theme.fg("muted", "No visible messages in this session."));
    this.lines = lines;
    this.width = width;
    this.dirty = false;
    this.matches = matches;
    if (this.matches.length) {
      this.matchIndex = Math.max(0, Math.min(this.matchIndex, this.matches.length - 1));
      if (this.jumpToMatch) this.scroll = this.matches[this.matchIndex]!.firstLine;
    } else this.matchIndex = -1;
    this.jumpToMatch = false;
  }
}
