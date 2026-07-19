import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";

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

function visibleCards(terminalWidth: number, terminalHeight: number): OverlayCardDefinition[] {
  return [...registry.cards.values()]
    .map(({ definition }) => definition)
    .filter((card) => {
      if (terminalWidth < (card.minTerminalWidth ?? 1)) return false;
      if (terminalHeight < (card.minTerminalHeight ?? 1)) return false;
      try {
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
    return Math.max(DEFAULT_WIDTH, ...visibleCards(this.terminalWidth, this.terminalHeight).map((card) => card.width ?? DEFAULT_WIDTH));
  }

  canRender(): boolean {
    return this.selectCards(this.rowBudget()).length > 0;
  }

  render(width: number): string[] {
    const cards = this.selectCards(this.rowBudget());
    if (cards.length === 0 || width <= 0) return [];

    const contentWidth = Math.max(1, width - 4);
    const shellRows = cards.length * 2 + Math.max(0, cards.length - 1);
    let remainingBodyRows = Math.max(0, this.rowBudget() - shellRows);
    const sections: Array<{ title: string; body: string[] }> = [];

    for (let index = 0; index < cards.length; index++) {
      const card = cards[index]!;
      const reserved = cards
        .slice(index + 1)
        .reduce((total, next) => total + (next.minBodyHeight ?? 1), 0);
      const available = Math.max(0, remainingBodyRows - reserved);
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
      sections.push({ title, body });
      remainingBodyRows -= body.length;
    }

    return sections.flatMap((section, index) => [
      ...(index === 0 ? [] : [" ".repeat(width)]),
      frameTop(section.title, width, this.theme),
      ...section.body.map((line) => frameBody(line, width, this.theme)),
      this.theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, width - 2))}╯`),
    ]).map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}

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

  render(): string[] {
    return [];
  }

  invalidate(): void {
    this.view.invalidate();
  }

  setHidden(hidden: boolean): void {
    this.handle.setHidden(hidden);
    this.tui.requestRender();
  }

  refresh(): void {
    this.view.invalidate();
    this.tui.requestRender();
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
    handler: (args, ctx) => {
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
