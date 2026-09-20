import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { HistoryPicker } from "../history-search/picker.ts";
import { rewindPrompts } from "./prompts.ts";

const MODAL_EVENT = "workflow-overlay:modal";

export default function rewindExtension(pi: ExtensionAPI): void {
  let choosing = false;
  let generation = 0;
  pi.on("session_start", () => { generation++; choosing = false; });
  pi.on("session_shutdown", () => { generation++; choosing = false; });

  const rewind = async (args: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Rewind requires interactive TUI mode.", "warning");
      return;
    }
    if (choosing) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      ctx.ui.notify("Finish or cancel the current run and queued messages before rewinding.", "warning");
      return;
    }
    const prompts = rewindPrompts(ctx.sessionManager.getBranch());
    if (!prompts.length) {
      ctx.ui.notify("No user prompts on the current branch to rewind to.", "info");
      return;
    }
    const query = args.trim();
    const version = generation;
    const leaf = ctx.sessionManager.getLeafId();
    let selected = query === "last" ? prompts[0] : undefined;
    if (!selected) {
      choosing = true;
      pi.events.emit(MODAL_EVENT, { id: "rewind", open: true });
      try {
        const label = await ctx.ui.custom<string | null>((tui, theme, keys, done) => new HistoryPicker(
          prompts.map((prompt, recency) => ({ text: prompt.label, source: "message", recency })),
          query, theme, keys, tui, done, { title: "Rewind · files stay unchanged", confirm: "fork & edit" },
        ), { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%", margin: 1 } });
        selected = prompts.find((prompt) => prompt.label === label);
      } finally {
        if (version === generation) {
          pi.events.emit(MODAL_EVENT, { id: "rewind", open: false });
          choosing = false;
        }
      }
    }
    if (version !== generation || !selected) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages() || leaf !== ctx.sessionManager.getLeafId()) {
      ctx.ui.notify("The session changed while choosing. Open /rewind again.", "warning");
      return;
    }
    const prompt = selected;
    // fork replaces the runtime. Only the callback's fresh context may be used
    // afterward; the original extension and command context become stale.
    await ctx.fork(prompt.id, {
      position: "before",
      withSession: async (fresh) => {
        fresh.ui.setEditorText(prompt.text);
        fresh.ui.notify(prompt.images
          ? `Prompt restored. Reattach ${prompt.images} image${prompt.images === 1 ? "" : "s"} before sending; files are unchanged.`
          : "Prompt restored for editing. The original session and workspace files are unchanged.", prompt.images ? "warning" : "info");
      },
    });
  };

  pi.registerCommand("rewind", { description: "Fork before a user prompt and restore it for editing: /rewind [query|last]", handler: rewind });
  pi.registerCommand("undo", { description: "Alias for /rewind; forks conversation history, does not undo file changes", handler: rewind });
}
