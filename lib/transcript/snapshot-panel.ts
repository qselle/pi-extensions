import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { TranscriptView, TRANSCRIPT_OVERLAY_OPTIONS } from "./view.ts";
import type { TranscriptBlock } from "./model.ts";

export class SnapshotPanel {
  private view?: TranscriptView;
  private revision = 0;
  private opening = false;
  constructor(private readonly pi: ExtensionAPI, private readonly id: string, private readonly title: string) {
    const reset = () => {
      this.revision++;
      this.view?.close(); this.view = undefined; this.opening = false;
      this.pi.events.emit("workflow-overlay:modal", { id: this.id, open: false });
    };
    pi.on("session_start", reset);
    pi.on("session_tree", reset);
    pi.on("session_shutdown", reset);
  }
  async open(ctx: ExtensionCommandContext, blocks: TranscriptBlock[], error = false): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(blocks.map((block) => `${block.label}\n${block.body}`).join("\n\n"), error ? "error" : "info");
      return;
    }
    if (this.opening) return;
    this.opening = true;
    const revision = this.revision;
    this.pi.events.emit("workflow-overlay:modal", { id: this.id, open: true });
    try {
      await ctx.ui.custom<void>((tui, theme, keys, done) => {
        const view = new TranscriptView(() => blocks, this.title, theme, keys, tui, done, "", "snapshot");
        if (revision !== this.revision) view.close();
        else this.view = view;
        return view;
      }, { overlay: true, overlayOptions: TRANSCRIPT_OVERLAY_OPTIONS });
    } finally {
      if (revision === this.revision) {
        this.view = undefined; this.opening = false;
        this.pi.events.emit("workflow-overlay:modal", { id: this.id, open: false });
      }
    }
  }
}
