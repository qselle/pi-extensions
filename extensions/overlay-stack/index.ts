import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";
import { bodyBudgets } from "./layout.ts";

const HOST_WIDGET_KEY = "workflow-overlay-host";
const REGISTRY_KEY = Symbol.for("@qselle/pi-extensions.overlay-stack.v1");
const MAX_HEIGHT_RATIO = 0.8;
const DEFAULT_WIDTH = 58;

export const OVERLAY_MODAL_EVENT = "workflow-overlay:modal";

export interface OverlayCardDefinition {
  id: string;
  order: number;
  visible: () => boolean;
  title: (theme: Theme) => string;
  renderBody: (width: number, maxHeight: number, theme: Theme) => string[];
  presentation?: () => "card" | "line";
  renderSummary?: (width: number, theme: Theme) => string;
  width?: number;
  minBodyHeight?: number;
  minTerminalWidth?: number;
  minTerminalHeight?: number;
}

export interface OverlayCardHandle {
  invalidate(): void;
  unregister(): void;
}

interface RegisteredCard {
  token: symbol;
  definition: OverlayCardDefinition;
}

interface OverlayRegistry {
  cards: Map<string, RegisteredCard>;
  listeners: Set<() => void>;
}

const registry = ((globalThis as Record<PropertyKey, unknown>)[REGISTRY_KEY] ??= {
  cards: new Map<string, RegisteredCard>(),
  listeners: new Set<() => void>(),
}) as OverlayRegistry;

function notifyRegistry(): void {
  for (const listener of registry.listeners) listener();
}

export function registerOverlayCard(definition: OverlayCardDefinition): OverlayCardHandle {
  const token = Symbol(definition.id);
  registry.cards.set(definition.id, { token, definition });
  notifyRegistry();
  return {
    invalidate: notifyRegistry,
    unregister() {
      if (registry.cards.get(definition.id)?.token !== token) return;
      registry.cards.delete(definition.id);
      notifyRegistry();
    },
  };
}

function fitsViewport(card: OverlayCardDefinition, width: number, height: number): boolean {
  return width >= (card.minTerminalWidth ?? 1) && height >= (card.minTerminalHeight ?? 1);
}

function visibleCards(terminalWidth: number, terminalHeight: number, includeCompact = false): OverlayCardDefinition[] {
  return [...registry.cards.values()]
    .map(({ definition }) => definition)
    .filter((card) => {
      try {
        if (!includeCompact && (card.presentation?.() === "line" || !fitsViewport(card, terminalWidth, terminalHeight))) return false;
        return card.visible();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export class OverlayStackView implements Component {
  private terminalWidth = 0;
  private terminalHeight = 0;

  constructor(private readonly theme: Theme) {}

  setViewport(width: number, height: number): void {
    this.terminalWidth = width;
    this.terminalHeight = height;
  }

  preferredWidth(): number {
    const cards = visibleCards(this.terminalWidth, this.terminalHeight);
    return cards.length ? Math.max(...cards.map((card) => card.width ?? DEFAULT_WIDTH)) : DEFAULT_WIDTH;
  }

  canRender(): boolean {
    return this.selectCards(this.rowBudget()).length > 0;
  }

  render(width: number): string[] {
    const cards = this.selectCards(this.rowBudget());
    if (cards.length === 0 || width <= 0) return [];

    const contentWidth = Math.max(1, width - 4);
    const shellRows = cards.length * 2 + Math.max(0, cards.length - 1);
    const availableBodyRows = Math.max(0, this.rowBudget() - shellRows);
    const budgets = bodyBudgets(cards.map((card) => card.minBodyHeight ?? 1), availableBodyRows);
    const sections: Array<{ title: string; body: string[]; card: OverlayCardDefinition; budget: number }> = [];

    for (let index = 0; index < cards.length; index++) {
      const card = cards[index]!;
      const available = budgets[index]!;
      let body: string[];
      let title: string;
      try {
        title = card.title(this.theme);
        body = card.renderBody(contentWidth, available, this.theme).slice(0, available);
      } catch {
        continue;
      }
      const minimum = card.minBodyHeight ?? 1;
      while (body.length < minimum) body.push("");
      sections.push({ title, body, card, budget: available });
    }

    // Short cards lend unused rows to cards that filled their share. Renderers
    // may use the larger budget to replace an overflow summary with more detail.
    let spare = availableBodyRows - sections.reduce((sum, section) => sum + section.body.length, 0);
    const full = sections.filter((section) => section.body.length >= section.budget);
    for (let index = 0; index < full.length && spare > 0; index++) {
      const section = full[index]!;
      const extra = Math.ceil(spare / (full.length - index));
      const budget = section.body.length + extra;
      try {
        const body = section.card.renderBody(contentWidth, budget, this.theme).slice(0, budget);
        // A second render must not lose content if a state change shrank it.
        if (body.length > section.body.length) {
          spare -= body.length - section.body.length;
          section.body = body;
        }
      } catch { /* Keep the valid first rendering. */ }
    }

    return sections.flatMap((section, index) => [
      ...(index === 0 ? [] : [" ".repeat(width)]),
      frameTop(section.title, width, this.theme),
      ...section.body.map((line) => frameBody(line, width, this.theme)),
      this.theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, width - 2))}╯`),
    ]).map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}

  /** Inline workflows and cards that do not fit share the space above the editor. */
  renderCompact(width: number): string[] {
    const limit = Math.min(3, Math.max(0, Math.floor((this.terminalHeight - 6) / 4)));
    if (width <= 0 || !limit) return [];
    const selected = new Set(this.selectCards(this.rowBudget()));
    const cards = visibleCards(this.terminalWidth, this.terminalHeight, true)
      .filter((card) => !selected.has(card));
    const rows: string[] = [];
    let shown = 0;
    const available = cards.length > limit && limit > 1 ? limit - 1 : limit;
    for (const card of cards) {
      if (rows.length >= available) break;
      try {
        if (card.renderSummary) {
          rows.push(truncateToWidth(card.renderSummary(width, this.theme), width, "…"));
        } else {
          const title = truncateToWidth(card.title(this.theme), Math.min(24, Math.max(8, Math.floor(width * 0.35))), "…");
          const bodyWidth = width - visibleWidth(title) - 3;
          const body = bodyWidth > 0 ? card.renderBody(bodyWidth, 1, this.theme)[0] : undefined;
          rows.push(truncateToWidth(body ? `${title}${this.theme.fg("dim", " · ")}${body}` : title, width, "…"));
        }
        shown++;
      } catch { /* A broken card must not hide the remaining workflow state. */ }
    }
    const remaining = cards.length - shown;
    if (remaining > 0 && rows.length) {
      const more = this.theme.fg("dim", `+${remaining} more workflow${remaining === 1 ? "" : "s"}`);
      if (rows.length < limit) rows.push(truncateToWidth(more, width, "…"));
      else {
        const badge = this.theme.fg("dim", ` · +${remaining}`);
        rows[rows.length - 1] = truncateToWidth(rows.at(-1)!, Math.max(0, width - visibleWidth(badge)), "…") + truncateToWidth(badge, width, "");
      }
    }
    return rows;
  }

  private rowBudget(): number {
    return Math.max(1, Math.floor(this.terminalHeight * MAX_HEIGHT_RATIO));
  }

  private selectCards(maxRows: number): OverlayCardDefinition[] {
    const selected: OverlayCardDefinition[] = [];
    for (const card of visibleCards(this.terminalWidth, this.terminalHeight)) {
      const next = [...selected, card];
      const shellRows = next.length * 2 + Math.max(0, next.length - 1);
      const bodyRows = next.reduce((total, item) => total + (item.minBodyHeight ?? 1), 0);
      if (shellRows + bodyRows <= maxRows) selected.push(card);
    }
    return selected;
  }
}

class OverlayStackHost implements Component {
  private readonly view: OverlayStackView;
  private readonly options: OverlayOptions;
  private readonly handle: OverlayHandle;
  private readonly stopListening: () => void;
  private disposed = false;
  private hidden = false;

  constructor(private readonly tui: TUI, theme: Theme) {
    this.view = new OverlayStackView(theme);
    this.options = {
      nonCapturing: true,
      anchor: "top-right",
      width: DEFAULT_WIDTH,
      maxHeight: "80%",
      margin: { top: 1, right: 2 },
      visible: (columns, rows) => {
        this.view.setViewport(columns, rows);
        this.options.width = Math.min(this.view.preferredWidth(), Math.max(28, Math.floor(columns * 0.46)));
        return this.view.canRender();
      },
    };
    this.handle = tui.showOverlay(this.view, this.options);
    const listener = () => this.refresh();
    registry.listeners.add(listener);
    this.stopListening = () => registry.listeners.delete(listener);
  }

  render(width: number): string[] {
    if (this.hidden || this.disposed) return [];
    this.view.setViewport(this.tui.terminal?.columns ?? width, this.tui.terminal?.rows ?? 24);
    return this.view.renderCompact(width);
  }

  invalidate(): void {
    this.view.invalidate();
  }

  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.handle.setHidden(hidden);
    this.tui.requestRender();
  }

  refresh(): void {
    this.view.invalidate();
    if (!this.hidden) this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopListening();
    this.handle.hide();
  }
}

export default function overlayStackExtension(pi: ExtensionAPI): void {
  let host: OverlayStackHost | undefined;
  let userHidden = false;
  const modalOwners = new Set<string>();

  const hidden = () => userHidden || modalOwners.size > 0;
  const syncVisibility = () => host?.setHidden(hidden());
  const setUserHidden = (next: boolean, ctx: ExtensionContext) => {
    userHidden = next;
    syncVisibility();
    ctx.ui.notify(`Workflow overlay ${next ? "hidden" : "shown"}.`, "info");
  };
  const toggle = (ctx: ExtensionContext) => setUserHidden(!userHidden, ctx);

  const stopModalListener = pi.events.on(OVERLAY_MODAL_EVENT, (event: unknown) => {
    if (!event || typeof event !== "object") return;
    const payload = event as { id?: unknown; open?: unknown };
    if (typeof payload.id !== "string" || typeof payload.open !== "boolean") return;
    if (payload.open) modalOwners.add(payload.id);
    else modalOwners.delete(payload.id);
    syncVisibility();
  });

  pi.registerCommand("overlay", {
    description: "Show, hide, or toggle the persistent workflow overlay: /overlay [toggle|show|hide|status]",
    getArgumentCompletions: (prefix) => {
      const values = ["toggle", "show", "hide", "status"];
      const items = values.filter((value) => value.startsWith(prefix.toLowerCase())).map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "toggle";
      if (action === "toggle") toggle(ctx);
      else if (action === "show") setUserHidden(false, ctx);
      else if (action === "hide") setUserHidden(true, ctx);
      else if (action === "status") ctx.ui.notify(`Workflow overlay is ${userHidden ? "hidden" : "shown"}.`, "info");
      else ctx.ui.notify("Usage: /overlay [toggle|show|hide|status]", "error");
    },
  });

  pi.registerShortcut("ctrl+shift+o", {
    description: "Toggle the persistent workflow overlay",
    handler: toggle,
  });

  pi.on("session_start", (_event, ctx) => {
    userHidden = false;
    modalOwners.clear();
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(HOST_WIDGET_KEY, (tui, theme) => {
      host = new OverlayStackHost(tui, theme);
      syncVisibility();
      return host;
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setWidget(HOST_WIDGET_KEY, undefined);
    host = undefined;
    modalOwners.clear();
    stopModalListener();
  });
}

function frameTop(rawTitle: string, width: number, theme: Theme): string {
  if (width === 1) return theme.fg("borderAccent", "│");
  const title = truncateToWidth(rawTitle, Math.max(1, width - 2), "…");
  const ruleWidth = Math.max(0, width - visibleWidth(title) - 2);
  return `${theme.fg("borderAccent", "╭")}${title}${theme.fg("borderAccent", "─".repeat(ruleWidth))}${theme.fg("borderAccent", "╮")}`;
}

function frameBody(raw: string, width: number, theme: Theme): string {
  if (width === 1) return theme.fg("borderAccent", "│");
  const contentWidth = Math.max(0, width - 4);
  const content = truncateToWidth(raw, contentWidth, "…");
  const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
  return `${theme.fg("borderAccent", "│ ")}${content}${padding}${theme.fg("borderAccent", " │")}`;
}
