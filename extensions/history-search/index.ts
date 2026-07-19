import {
  CustomEditor,
  type EditorFactory,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { extractHistory, initialHistoryQuery } from "./history.ts";
import { HistoryPicker } from "./picker.ts";

const SHORTCUT = "ctrl+r";
const OVERLAY_MODAL_EVENT = "workflow-overlay:modal";

class HistorySearchEditor extends CustomEditor {
  private readonly delegate: ReturnType<EditorFactory> | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly openSearch: () => void,
    previousFactory?: EditorFactory,
  ) {
    super(tui, theme, keybindings);
    this.delegate = previousFactory
      ? (() => {
          try {
            return previousFactory(tui, theme, keybindings);
          } catch {
            return undefined;
          }
        })()
      : undefined;

    // Preserve wrappers such as accent-color that lock the editor border.
    if (this.delegate?.borderColor !== undefined) {
      Object.defineProperty(this, "borderColor", {
        configurable: true,
        enumerable: true,
        get: () => this.delegate?.borderColor,
        set: (value) => {
          if (this.delegate) this.delegate.borderColor = value;
        },
      });
    }
  }

  override handleInput(data: string): void {
    if (matchesKey(data, SHORTCUT)) {
      this.openSearch();
      return;
    }
    super.handleInput(data);
  }
}

export default function historySearchExtension(pi: ExtensionAPI) {
  let recentInputs: string[] = [];
  let pickerOpen = false;
  let previousFactory: EditorFactory | undefined;
  let installedFactory: EditorFactory | undefined;

  const openHistorySearch = async (ctx: ExtensionContext, explicitQuery?: string) => {
    if (pickerOpen) return;
    if (ctx.mode !== "tui") {
      ctx.ui.notify("History search is available in interactive TUI mode.", "warning");
      return;
    }

    const history = extractHistory(ctx.sessionManager.getBranch(), recentInputs);
    if (history.length === 0) {
      ctx.ui.notify("No prompt history is available in the current session.", "info");
      return;
    }

    const draft = ctx.ui.getEditorText();
    const initialQuery = explicitQuery === undefined ? initialHistoryQuery(draft) : explicitQuery;
    pickerOpen = true;
    pi.events.emit(OVERLAY_MODAL_EVENT, { id: "history-search", open: true });
    try {
      const selected = await ctx.ui.custom<string | null>(
        (tui, theme, keybindings, done) =>
          new HistoryPicker(history, initialQuery, theme, keybindings, tui, done),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "70%",
            minWidth: 44,
            maxHeight: "80%",
            margin: 1,
          },
        },
      );
      if (selected !== null) ctx.ui.setEditorText(selected);
    } finally {
      pi.events.emit(OVERLAY_MODAL_EVENT, { id: "history-search", open: false });
      pickerOpen = false;
    }
  };

  pi.registerCommand("history-search", {
    description: "Fuzzy-search prompt history and place the selection in the editor",
    handler: async (args, ctx) => openHistorySearch(ctx, args.trim() || undefined),
  });

  pi.on("input", (event) => {
    if (event.source !== "interactive") return;
    const text = event.text.trim();
    if (!text || /^\/history-search(?:\s|$)/i.test(text)) return;
    recentInputs.push(text);
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "reload") recentInputs = [];
    if (ctx.mode !== "tui") return;

    previousFactory = ctx.ui.getEditorComponent();
    installedFactory = (tui, theme, keybindings) =>
      new HistorySearchEditor(
        tui,
        theme,
        keybindings,
        () => {
          void openHistorySearch(ctx).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`History search failed: ${message}`, "error");
          });
        },
        previousFactory,
      );
    ctx.ui.setEditorComponent(installedFactory);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (ctx.ui.getEditorComponent() === installedFactory) {
      ctx.ui.setEditorComponent(previousFactory);
    }
    previousFactory = undefined;
    installedFactory = undefined;
  });

  pi.on("session_tree", () => {
    recentInputs = [];
  });
}
