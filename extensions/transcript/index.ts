import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { transcriptBlocks } from "../../lib/transcript/model.ts";
import { TranscriptView, TRANSCRIPT_OVERLAY_OPTIONS } from "../../lib/transcript/view.ts";

export default function transcriptExtension(pi: ExtensionAPI): void {
  let view: TranscriptView | undefined;
  let opening = false;
  let generation = 0;
  let streaming: unknown;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const clearRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };
  const refresh = () => { clearRefresh(); view?.refresh(); };

  const open = async (ctx: ExtensionContext, args = "") => {
    if (ctx.mode !== "tui") { ctx.ui.notify("Transcript viewing requires interactive TUI mode.", "info"); return; }
    if (opening) return;
    opening = true;
    const version = generation;
    const all = args.trim() === "all" || args.trim().startsWith("all ");
    const query = (all ? args.trim().slice(3) : args).trim();
    pi.events.emit("workflow-overlay:modal", { id: "transcript", open: true });
    try {
      await ctx.ui.custom<void>((tui, theme, keys, done) => {
        view = new TranscriptView(() => {
          const entries = all ? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch();
          const pending = streaming && !entries.some((entry) => entry.type === "message" && entry.message === streaming);
          return transcriptBlocks(pending ? [...entries, { id: "streaming", type: "message", message: streaming }] : entries);
        }, all ? "all branches" : "current branch", theme, keys, tui, done, query);
        return view;
      }, { overlay: true, overlayOptions: TRANSCRIPT_OVERLAY_OPTIONS });
    } finally {
      if (version === generation) {
        clearRefresh();
        view = undefined;
        opening = false;
        pi.events.emit("workflow-overlay:modal", { id: "transcript", open: false });
      }
    }
  };

  pi.registerCommand("transcript", { description: "Browse and search the full session transcript: /transcript [all] [query]", handler: (args, ctx) => open(ctx, args) });
  pi.registerShortcut("ctrl+shift+t", { description: "Open searchable session transcript", handler: (ctx) => open(ctx) });
  pi.on("message_update", (event) => {
    streaming = event.message;
    if (view && !refreshTimer) {
      refreshTimer = setTimeout(refresh, 100);
      refreshTimer.unref?.();
    }
  });
  // Pi emits message_end before appending the message to the session manager.
  // Keep it as a pending display row until the saved branch contains that object.
  pi.on("message_end", (event) => { streaming = event.message; refresh(); });
  pi.on("session_compact", () => view?.refresh());
  pi.on("session_tree", () => { streaming = undefined; view?.refresh(); });
  pi.on("agent_settled", () => { streaming = undefined; view?.refresh(); });
  pi.on("session_start", () => { generation++; clearRefresh(); view?.close(); view = undefined; opening = false; streaming = undefined; });
  pi.on("session_shutdown", () => {
    generation++;
    clearRefresh();
    view?.close();
    view = undefined;
    opening = false;
    streaming = undefined;
  });
}
