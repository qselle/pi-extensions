import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandCatalog } from "./catalog.ts";
import { CommandPicker } from "./picker.ts";

export default function commandPaletteExtension(pi: ExtensionAPI): void {
  let open = false;
  let generation = 0;
  let close: (() => void) | undefined;
  let savedDraft: string | undefined;
  const modal = (value: boolean) => pi.events.emit("workflow-overlay:modal", { id: "command-palette", open: value });
  const reset = () => {
    generation++;
    close?.(); close = undefined;
    if (open) modal(false);
    open = false; savedDraft = undefined;
  };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);

  async function show(ctx: ExtensionContext, query = "") {
    if (ctx.mode !== "tui") { ctx.ui.notify("Use /palette in the interactive TUI.", "info"); return; }
    if (open) return;
    const commands = commandCatalog(pi.getCommands());
    const version = generation;
    const draft = ctx.ui.getEditorText();
    open = true;
    modal(true);
    try {
      const result = await ctx.ui.custom<string | null>((tui, theme, keys, done) => {
        if (version !== generation) done(null);
        else close = () => done(null);
        return new CommandPicker(commands, query, theme, keys, tui, done);
      }, { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "85%", margin: 0 } });
      if (version === generation && result && commands.some((command) => command.name === result)) {
        if (draft.trim()) savedDraft = draft;
        ctx.ui.setEditorText(`/${result} `);
      }
    } finally {
      if (version === generation) { close = undefined; open = false; modal(false); }
    }
  }

  pi.registerCommand("palette", {
    description: "Search extension, prompt and skill commands; /palette restore recovers the replaced draft",
    async handler(args, ctx) {
      if (args.trim() === "restore") {
        if (ctx.mode !== "tui") { ctx.ui.notify("Use /palette in the interactive TUI.", "info"); return; }
        if (savedDraft === undefined) { ctx.ui.notify("No draft saved by the command palette in this session.", "info"); return; }
        ctx.ui.setEditorText(savedDraft); savedDraft = undefined;
        return;
      }
      await show(ctx, args.trim());
    },
  });
  pi.registerShortcut("ctrl+shift+p", { description: "Search extension, prompt and skill commands", handler: (ctx) => show(ctx) });
}
