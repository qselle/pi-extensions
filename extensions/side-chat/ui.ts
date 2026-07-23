import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

// pi-tui's `Key` value export isn't reliably importable across runtimes (it
// fails to load under some). Its values are plain key-id strings that
// matchesKey accepts, so define the ones we use locally.
const Key = {
  up: "up",
  down: "down",
  right: "right",
  enter: "enter",
  escape: "escape",
  home: "home",
  end: "end",
  pageUp: "pageUp",
  pageDown: "pageDown",
} as const;
import { compactText } from "./prompts.ts";
import { formatSideUsage, isEmptyUsage } from "./usage.ts";
import { modelLabel, type SideChat } from "./types.ts";

export interface WorkspaceCallbacks {
  list: () => SideChat[];
  onSend: (id: string, text: string) => void;
  onRetry: (id: string) => void;
  onAbort: (id: string) => void;
  onPromote: (id: string) => string;
  onNew: () => SideChat | undefined;
  onDelete: (id: string) => void;
}

export interface WorkspaceInitial {
  chatId?: string;
  mode?: "list" | "chat";
}

type ViewMode = "list" | "chat";

/**
 * Interactive side-chat workspace: a navigable list of chats plus a per-chat
 * transcript with an embedded follow-up input. Reads chats live from the store
 * so background answers appear as they land.
 */
export class SideChatWorkspace implements Component, Focusable {
  private mode: ViewMode = "list";
  private activeId?: string;
  private scroll = 0;
  private maxScroll = 0;
  private followTail = true;
  private pendingDelete?: string;
  private notice?: string;
  private _focused = false;
  private rev = 0;
  private bodyCache?: { width: number; id: string; rev: number; lines: string[] };
  private readonly input = new Input();

  constructor(
    private readonly callbacks: WorkspaceCallbacks,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly tui: TUI,
    private readonly done: () => void,
    initial?: WorkspaceInitial,
  ) {
    const chats = this.callbacks.list();
    this.activeId = initial?.chatId ?? chats[0]?.id;
    if (initial?.mode === "chat" && this.activeId) this.enterChat(this.activeId);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.mode === "chat";
  }

  /** Called by the host when the store changes. */
  refresh(): void {
    this.rev += 1;
  }

  invalidate(): void {
    this.rev += 1;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const height = this.viewportHeight();
    return this.mode === "chat" && this.activeChat()
      ? this.renderChat(safeWidth, height)
      : this.renderList(safeWidth, height);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+shift+s")) {
      this.done();
      return;
    }
    if (this.mode === "chat" && this.activeChat()) this.handleChatInput(data);
    else this.handleListInput(data);
  }

  // ── list view ────────────────────────────────────────────────────────────

  private renderList(width: number, height: number): string[] {
    const chats = this.callbacks.list();
    const active = chats.filter((chat) => chat.status === "generating").length;
    const lines: string[] = [];
    lines.push(truncateToWidth(
      `${this.theme.fg("accent", this.theme.bold("Side chats"))} ${this.theme.fg("dim", `· ${chats.length} ${plural(chats.length, "chat")}${active ? ` · ${active} generating` : ""}`)}`,
      width,
      "…",
    ));
    lines.push(divider(width, this.theme));

    const bodyHeight = Math.max(1, height - 3);
    const rows: string[] = [];
    if (chats.length === 0) {
      rows.push(this.theme.fg("dim", "No side chats yet."));
      rows.push(this.theme.fg("dim", "Press n to start one, or run /side <question>."));
    } else {
      const selected = this.selectedIndex(chats);
      for (let index = 0; index < chats.length; index++) {
        rows.push(this.listRow(chats[index]!, index === selected, width));
      }
    }
    const visible = rows.slice(0, bodyHeight);
    while (visible.length < bodyHeight) visible.push("");

    lines.push(...visible);
    lines.push(divider(width, this.theme));
    lines.push(truncateToWidth(this.theme.fg("dim", this.listFooter()), width, ""));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private listRow(chat: SideChat, selected: boolean, width: number): string {
    const pointer = selected ? this.theme.fg("accent", "❯ ") : "  ";
    const symbol = statusSymbol(chat, this.theme);
    const answers = chat.turns.filter((turn) => turn.role === "assistant").length;
    const meta = this.theme.fg(
      "dim",
      `${chat.model.id} · ${answers} ${plural(answers, "reply", "replies")}`,
    );
    const title = selected ? this.theme.bold(chat.title) : chat.title;
    const deleteHint = this.pendingDelete === chat.id ? this.theme.fg("error", " · press d to confirm") : "";
    return truncateToWidth(`${pointer}${symbol} ${title}  ${meta}${deleteHint}`, width, "…");
  }

  private listFooter(): string {
    if (this.notice) return this.notice;
    return "↑↓ select · ⏎ open · n new · d delete · Esc close";
  }

  private handleListInput(data: string): void {
    const chats = this.callbacks.list();
    if (this.pendingDelete && data !== "d") this.pendingDelete = undefined;

    if (matchesKey(data, Key.up) || data === "k") {
      this.moveSelection(chats, -1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.moveSelection(chats, 1);
    } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
      if (this.activeId) this.enterChat(this.activeId);
    } else if (data === "n") {
      const chat = this.callbacks.onNew();
      if (chat) this.enterChat(chat.id);
    } else if (data === "d") {
      this.confirmDelete(chats);
    } else if (matchesKey(data, Key.escape) || data === "q") {
      this.done();
      return;
    } else {
      return;
    }
    this.touch();
  }

  private confirmDelete(chats: SideChat[]): void {
    if (!this.activeId) return;
    if (this.pendingDelete === this.activeId) {
      const removingIndex = chats.findIndex((chat) => chat.id === this.activeId);
      this.callbacks.onDelete(this.activeId);
      this.pendingDelete = undefined;
      const remaining = this.callbacks.list();
      this.activeId = remaining[Math.min(removingIndex, remaining.length - 1)]?.id;
      this.notice = "Side chat deleted.";
    } else {
      this.pendingDelete = this.activeId;
    }
  }

  private moveSelection(chats: SideChat[], delta: number): void {
    if (chats.length === 0) return;
    const current = this.selectedIndex(chats);
    const next = Math.min(chats.length - 1, Math.max(0, current + delta));
    this.activeId = chats[next]!.id;
    this.notice = undefined;
  }

  private selectedIndex(chats: SideChat[]): number {
    const index = chats.findIndex((chat) => chat.id === this.activeId);
    return index >= 0 ? index : 0;
  }

  // ── chat view ────────────────────────────────────────────────────────────

  private renderChat(width: number, height: number): string[] {
    const chat = this.activeChat()!;
    const bodyHeight = Math.max(1, height - 4);
    const body = this.transcript(width, chat);
    this.maxScroll = Math.max(0, body.length - bodyHeight);
    this.scroll = this.followTail ? this.maxScroll : Math.min(this.scroll, this.maxScroll);
    const percent = this.maxScroll === 0 ? 100 : Math.round((this.scroll / this.maxScroll) * 100);

    const header = truncateToWidth(
      `${statusSymbol(chat, this.theme)} ${this.theme.fg("accent", this.theme.bold(chat.title))} ${this.theme.fg("dim", `· ${modelLabel(chat.model)} · ${statusText(chat, this.theme)}`)}`,
      width,
      "…",
    );

    const visible = body.slice(this.scroll, this.scroll + bodyHeight).map((line) => truncateToWidth(line, width, ""));
    while (visible.length < bodyHeight) visible.push("");

    const promptWidth = visibleWidth("› ");
    const inputLine = `${this.theme.fg("accent", "› ")}${this.input.render(Math.max(1, width - promptWidth))[0] ?? ""}`;
    const footer = truncateToWidth(this.theme.fg("dim", this.chatFooter(chat, percent)), width, "");

    return [header, divider(width, this.theme), ...visible, truncateToWidth(inputLine, width, ""), footer];
  }

  private chatFooter(chat: SideChat, percent: number): string {
    if (this.notice) return this.notice;
    if (chat.status === "error") return "Ctrl+R retry · ⏎ new question · Esc back · Ctrl+O promote · Esc→Esc close";
    if (chat.status === "generating") return `⏎ queue · Ctrl+X stop · PgUp/PgDn scroll · Esc back · ${percent}%`;
    return `⏎ send · PgUp/PgDn scroll · End follow · Ctrl+O promote · Esc back · ${percent}%`;
  }

  private handleChatInput(data: string): void {
    const chat = this.activeChat();
    if (!chat) {
      this.exitChat();
      return;
    }
    const page = Math.max(4, this.viewportHeight() - 6);
    if (matchesKey(data, Key.escape)) {
      this.exitChat();
    } else if (matchesKey(data, Key.enter)) {
      const text = this.input.getValue().trim();
      if (text) {
        this.callbacks.onSend(chat.id, text);
        this.input.setValue("");
        this.followTail = true;
        this.notice = undefined;
      }
    } else if (matchesKey(data, Key.pageUp)) {
      this.followTail = false;
      this.scroll = Math.max(0, this.scroll - page);
    } else if (matchesKey(data, Key.pageDown)) {
      this.scroll = Math.min(this.maxScroll, this.scroll + page);
      this.followTail = this.scroll >= this.maxScroll;
    } else if (matchesKey(data, Key.home)) {
      this.followTail = false;
      this.scroll = 0;
    } else if (matchesKey(data, Key.end)) {
      this.followTail = true;
    } else if (matchesKey(data, "ctrl+r")) {
      this.callbacks.onRetry(chat.id);
    } else if (matchesKey(data, "ctrl+o")) {
      this.notice = this.callbacks.onPromote(chat.id);
    } else if (matchesKey(data, "ctrl+x")) {
      this.callbacks.onAbort(chat.id);
    } else {
      this.input.handleInput(data);
    }
    this.touch();
  }

  private transcript(width: number, chat: SideChat): string[] {
    if (this.bodyCache && this.bodyCache.width === width && this.bodyCache.id === chat.id && this.bodyCache.rev === this.rev) {
      return this.bodyCache.lines;
    }
    const lines: string[] = [];
    if (chat.contextMode === "snapshot") {
      appendSection(lines, [this.theme.fg("dim", `context: main-conversation snapshot${chat.contextTruncated ? " (truncated)" : ""}`)]);
    }
    if (chat.turns.length === 0 && !chat.pending) {
      appendSection(lines, [this.theme.fg("dim", "Ask anything about the session or the problem. This stays out of the main context.")]);
    }
    for (const turn of chat.turns) {
      if (turn.role === "user") {
        appendSection(lines, section("›", "you", "accent", turn.text, "text", width, this.theme));
      } else {
        const label = turn.usage && !isEmptyUsage(turn.usage) ? `${turn.model ?? "assistant"} · ${formatSideUsage(turn.usage, "")?.trim() ?? ""}` : (turn.model ?? "assistant");
        appendSection(lines, section("●", label, "success", turn.text, "text", width, this.theme));
      }
    }
    if (chat.pending) {
      appendSection(lines, section("›", "you", "accent", chat.pending.text, "text", width, this.theme));
      if (chat.status === "generating") {
        appendSection(lines, [`${this.theme.fg("accent", "●")} ${this.theme.fg("accent", "assistant")}`, `  ${this.theme.fg("dim", "▌ thinking…")}`]);
      }
    }
    if (chat.status === "error" && chat.error) {
      appendSection(lines, section("×", "error", "error", chat.error, "error", width, this.theme));
    }
    this.bodyCache = { width, id: chat.id, rev: this.rev, lines };
    return lines;
  }

  private enterChat(id: string): void {
    this.mode = "chat";
    this.activeId = id;
    this.scroll = 0;
    this.followTail = true;
    this.pendingDelete = undefined;
    this.notice = undefined;
    this.input.setValue("");
    this.input.focused = this._focused;
    this.rev += 1;
  }

  private exitChat(): void {
    this.mode = "list";
    this.input.focused = false;
    this.notice = undefined;
    this.rev += 1;
  }

  private activeChat(): SideChat | undefined {
    return this.activeId ? this.callbacks.list().find((chat) => chat.id === this.activeId) : undefined;
  }

  private touch(): void {
    this.rev += 1;
    this.tui.requestRender();
  }

  private viewportHeight(): number {
    const rows = (this.tui as TUI & { terminal?: { rows?: number } }).terminal?.rows ?? process.stdout.rows ?? 24;
    return Math.max(8, Math.floor(rows * 0.84) - 2);
  }
}

// ── shared rendering helpers ─────────────────────────────────────────────────

/** Overlay-card body: compact, ambient view of side chats during a long job. */
export function renderSideCard(chats: readonly SideChat[], width: number, maxHeight: number, theme: Theme): string[] {
  if (width <= 0 || maxHeight <= 0) return [];
  const ordered = [...chats].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  const lines: string[] = [];
  for (const chat of ordered) {
    if (lines.length >= maxHeight) break;
    const answers = chat.turns.filter((turn) => turn.role === "assistant").length;
    const detail = chat.status === "generating" ? "generating…" : chat.status === "error" ? "error" : `${answers} ${plural(answers, "reply", "replies")}`;
    lines.push(truncateToWidth(`${statusSymbol(chat, theme)} ${theme.bold(compactText(chat.title, Math.max(8, width - 16)))} ${theme.fg("dim", detail)}`, width, "…"));
  }
  if (lines.length === 0) lines.push(theme.fg("dim", "No side chats"));
  return lines.slice(0, maxHeight);
}

/** Renderer for a promoted side answer surfaced into the main transcript. */
export function renderPromotedMessage(content: string, theme: Theme): Component {
  const body = content.trim() || "(empty)";
  return {
    render: (width: number) => {
      const safe = Math.max(1, width);
      const header = truncateToWidth(`${theme.fg("muted", "•")} ${theme.bold("Promoted side answer")}`, safe, "…");
      const lines = wrapTextWithAnsi(body, safe).map((line) => truncateToWidth(theme.fg("muted", line), safe, ""));
      return [header, ...lines];
    },
    invalidate() {},
  };
}

export function statusSymbol(chat: SideChat, theme: Theme): string {
  if (chat.status === "generating") return theme.fg("accent", "●");
  if (chat.status === "error") return theme.fg("error", "×");
  return theme.fg("success", "✓");
}

export function statusText(chat: SideChat, theme: Theme): string {
  if (chat.status === "generating") return theme.fg("accent", "generating…");
  if (chat.status === "error") return theme.fg("error", "error");
  return theme.fg("dim", "idle");
}

function section(
  symbol: string,
  label: string,
  labelColor: Parameters<Theme["fg"]>[0],
  body: string,
  bodyColor: Parameters<Theme["fg"]>[0],
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

function divider(width: number, theme: Theme): string {
  return theme.fg("dim", "─".repeat(Math.max(1, width)));
}

function rank(chat: SideChat): number {
  if (chat.status === "generating") return 0;
  if (chat.status === "error") return 1;
  return 2;
}

function plural(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function clean(text: string): string {
  return String(text)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
