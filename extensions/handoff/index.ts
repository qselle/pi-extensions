import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { knownSecretValues } from "../questions/secrets.ts";
import { TranscriptView } from "../../lib/transcript/view.ts";
import { checkpoint, contextText, HANDOFF_CONTEXT, HANDOFF_ENTRY, latestCheckpoint, latestUser, workflowState } from "./state.ts";

export default function handoffExtension(pi: ExtensionAPI): void {
  let generation = 0;
  let busy = false;
  let view: TranscriptView | undefined;
  const reset = () => { generation++; busy = false; view?.close(); view = undefined; };
  pi.on("session_start", reset); pi.on("session_shutdown", reset);
  pi.registerTool({
    name: "prepare_handoff", label: "Prepare context handoff",
    description: "Save a durable checkpoint for a user-reviewed fresh-context handoff. Include the full user objective and constraints, decisions with reasons, changed files, exact verification evidence, unfinished work, and the next concrete action. Distinguish verified facts from assumptions. Do not include secrets. This only prepares a checkpoint; the user can inspect /handoff and initiate /handoff new. It does not replace the session or mark the task complete.",
    parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 20000 }), next_prompt: Type.Optional(Type.String({ maxLength: 2000 })) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const value = checkpoint(params.summary, params.next_prompt ?? "", ctx.sessionManager.getSessionId(), latestUser(ctx.sessionManager.getBranch()), knownSecretValues());
      pi.appendEntry(HANDOFF_ENTRY, value);
      return { content: [{ type: "text", text: "Handoff checkpoint saved. The user can inspect /handoff, edit /handoff edit, or start a fresh context with /handoff new. Current work remains in this session." }], details: { characters: value.summary.length } };
    },
  });
  pi.registerCommand("handoff", {
    description: "Review a checkpoint, edit it, or start fresh context: /handoff [edit|new]",
    async handler(args, ctx) {
      const action = args.trim();
      if (!["", "edit", "new"].includes(action)) { ctx.ui.notify("Usage: /handoff [edit|new]", "info"); return; }
      if (busy) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) { ctx.ui.notify("Finish or cancel the current run and queued messages before handing off.", "warning"); return; }
      const entries = ctx.sessionManager.getBranch();
      const value = latestCheckpoint(entries);
      if (!value) { ctx.ui.notify("No handoff checkpoint. Ask the agent to prepare one with the full objective, evidence, and unfinished work.", "info"); return; }
      const stale = value.sourceSession !== ctx.sessionManager.getSessionId() || value.sourceUser !== latestUser(entries);
      if (action === "new" && stale) { ctx.ui.notify("A newer user turn or different session makes this checkpoint stale. Prepare or edit it before starting a new context.", "warning"); return; }
      const version = generation;
      const leaf = ctx.sessionManager.getLeafId();
      busy = true;
      const unchanged = () => version === generation && ctx.isIdle() && !ctx.hasPendingMessages() && leaf === ctx.sessionManager.getLeafId();
      try {
        if (action === "edit") {
          if (ctx.mode !== "tui") { ctx.ui.notify("Editing a handoff requires TUI mode.", "warning"); return; }
          const text = await ctx.ui.editor("Handoff · preserve the full objective and remaining work", value.summary);
          if (text === undefined) return;
          if (!unchanged()) { if (version === generation) ctx.ui.notify("The session changed while editing. Open /handoff edit again.", "warning"); return; }
          pi.appendEntry(HANDOFF_ENTRY, checkpoint(text, value.nextPrompt, ctx.sessionManager.getSessionId(), latestUser(entries), knownSecretValues()));
          ctx.ui.notify("Checkpoint updated. Use /handoff new when ready.", "info");
        } else if (action === "new") {
          const states = workflowState(entries);
          // Seed through the public setup callback before the new runtime restores extensions.
          // Only the fresh callback context is valid after replacement.
          await ctx.newSession({ parentSession: ctx.sessionManager.getSessionFile(), setup: async (manager) => {
            manager.appendCustomEntry(HANDOFF_ENTRY, value);
            manager.appendCustomMessageEntry(HANDOFF_CONTEXT, contextText(value), true, { sourceSession: value.sourceSession, createdAt: value.createdAt });
            for (const state of states) manager.appendCustomEntry(state.type, state.data);
          }, withSession: async (fresh) => {
            if (value.nextPrompt) fresh.ui.setEditorText(value.nextPrompt);
            fresh.ui.notify("Fresh context created with the checkpoint and goal/plan/journal state. The original session is preserved; workspace files are unchanged.", "info");
          } });
        } else if (ctx.mode !== "tui") {
          ctx.ui.notify(`${stale ? "Checkpoint needs review after newer messages.\n\n" : ""}${value.summary}\n\nNext prompt (not submitted): ${value.nextPrompt || "none"}`, "info");
        } else {
          pi.events.emit("workflow-overlay:modal", { id: "handoff", open: true });
          try {
            await ctx.ui.custom<void>((tui, theme, keys, done) => {
              view = new TranscriptView(() => [{ id: "summary", label: stale ? "Checkpoint · needs review" : "Checkpoint · /handoff new to continue", kind: "assistant", body: value.summary }, { id: "next", label: "Next prompt · not submitted", kind: "user", body: value.nextPrompt || "No draft prompt." }], "handoff", theme, keys, tui, done);
              return view;
            }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 } });
          } finally { if (version === generation) pi.events.emit("workflow-overlay:modal", { id: "handoff", open: false }); }
        }
      } finally { if (version === generation) { busy = false; view = undefined; } }
    },
  });
}
