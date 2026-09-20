import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { redactText } from "../../lib/redact.ts";
import { knownSecretValues } from "../questions/secrets.ts";
import { contextBudget, installRollover } from "./rollover.ts";
import { emptyJournal, historyMatches, journalPrompt, JOURNAL_CONTEXT, JOURNAL_ENTRY, restoreJournal, updateNote } from "./state.ts";

const TOOLS = ["context_notes", "context_history", "context_budget", "context_rollover"];
export default function contextJournalExtension(pi: ExtensionAPI): void {
  let state = emptyJournal();
  const rollover = installRollover(pi, () => state);
  const activate = () => {
    const active = pi.getActiveTools().filter((name) => !TOOLS.includes(name));
    pi.setActiveTools(state.enabled ? [...active, ...TOOLS] : active);
  };
  const requireEnabled = () => { if (!state.enabled) throw new Error("Session context journal is disabled. Enable it with /context-journal on."); };
  pi.registerCommand("context-journal", {
    description: "Durable per-session notes and history retrieval: /context-journal on|off|status|reset",
    async handler(args, ctx) {
      const action = args.trim() || "status";
      if (action === "on" || action === "off") { const next = { ...state, enabled: action === "on" }; pi.appendEntry(JOURNAL_ENTRY, next); state = next; if (!state.enabled) rollover.disable(); activate(); }
      else if (action === "reset") {
        if (!state.enabled) { ctx.ui.notify("Enable /context-journal on first.", "warning"); return; }
        if (!ctx.isIdle() || ctx.hasPendingMessages()) { ctx.ui.notify("Finish the current run and queued messages before resetting context.", "warning"); return; }
        await rollover.rollover(ctx);
      }
      else if (action !== "status") { ctx.ui.notify("Usage: /context-journal on|off|status|reset", "info"); return; }
      ctx.ui.setStatus?.("context-journal", state.enabled ? "ctx:auto" : undefined);
      ctx.ui.notify(`Context journal ${state.enabled ? "enabled" : "disabled"} · ${Object.keys(state.notes).length}/32 notes · ${Object.values(state.notes).join("").length}/16000 characters. Disabling keeps saved notes.`, "info");
    },
  });
  pi.registerTool({ name: "context_notes", label: "Session notes",
    description: "List, read, replace or delete durable keyed working notes on the current session branch. Preserve the full objective, constraints, decisions, verified evidence and unfinished work. Notes enter future model context while enabled. No secrets. Limits: 32 notes, 4000 characters each, 16000 total.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("write"), Type.Literal("delete")]), key: Type.Optional(Type.String({ maxLength: 64 })), text: Type.Optional(Type.String({ maxLength: 4000 })) }),
    async execute(_id, params, signal) {
      signal?.throwIfAborted(); requireEnabled();
      let text: string;
      if (params.action === "list") text = Object.entries(state.notes).map(([key, value]) => `${key} · ${value.length} characters`).join("\n") || "No session notes.";
      else {
        if (!params.key) throw new Error("This action requires a note key.");
        if (params.action === "read") { if (!Object.hasOwn(state.notes, params.key)) throw new Error("Unknown note key."); text = redactText(state.notes[params.key]!, knownSecretValues()); }
        else {
          if (params.action === "write" && params.text === undefined) throw new Error("Writing a note requires text.");
          const next = updateNote(state, params.key, params.action === "delete" ? null : params.text!, knownSecretValues());
          pi.appendEntry(JOURNAL_ENTRY, next); state = next;
          rollover.checkpoint();
          text = params.action === "delete" ? "Note deleted from current state; append-only history retains earlier versions." : "Session note saved.";
        }
      }
      return { content: [{ type: "text", text }], details: {} };
    },
  });
  pi.registerTool({ name: "context_history", label: "Retrieve session history",
    description: "Search text across the complete current session branch, including messages before compaction. Returns newest matches with stable entry IDs and excerpts around the match. Use nextBefore as before to page older results. Hidden extension messages, reasoning and image data are excluded.",
    parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: 500 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), before: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted(); requireEnabled();
      const result = historyMatches(ctx.sessionManager.getBranch(), params.query, params.limit, params.before, knownSecretValues());
      const matches = result.matches.map((item) => `${item.id} · ${item.role}\n${item.excerpt}`).join("\n\n") || "No matching messages on this branch.";
      const continuation = result.nextBefore ? `More matches available. Continue with before=${JSON.stringify(result.nextBefore)} and the same query.` : "End of matching history on this branch.";
      return { content: [{ type: "text", text: `${matches}\n\n${continuation}` }], details: { nextBefore: result.nextBefore, count: result.matches.length } };
    },
  });
  pi.registerTool({ name: "context_budget", label: "Inspect context budget", description: "Report Pi's current context estimate; unknown usage is not treated as zero.", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      requireEnabled(); const usage = ctx.getContextUsage();
      return { content: [{ type: "text", text: usage ? JSON.stringify({ ...usage, budget: contextBudget(usage) }) : "Context usage is currently unknown." }], details: {} };
    },
  });
  pi.on("context", (event) => {
    const messages = event.messages.filter((message) => !("customType" in message && message.customType === JOURNAL_CONTEXT));
    if (state.enabled && Object.keys(state.notes).length) messages.push({ role: "custom", customType: JOURNAL_CONTEXT, content: redactText(journalPrompt(state), knownSecretValues()), display: false, timestamp: Date.now() } as typeof messages[number]);
    return { messages };
  });
  const restore = (_event: unknown, ctx: any) => { state = restoreJournal(ctx.sessionManager.getBranch()); activate(); ctx.ui.setStatus?.("context-journal", state.enabled ? "ctx:auto" : undefined); };
  pi.on("session_start", restore); pi.on("session_tree", restore);
}
