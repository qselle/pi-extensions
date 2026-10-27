import type { ExtensionAPI, ExtensionContext, ContextUsage } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { redactText } from "../../lib/redact.ts";
import { knownSecretValues } from "../questions/secrets.ts";
import { journalPrompt, type Journal } from "./state.ts";
import { CHECKPOINT_ENTRY, currentCheckpoint, ROLLOVER_BOUNDARY } from "./checkpoint.ts";

export { ROLLOVER_BOUNDARY } from "./checkpoint.ts";
export const BUDGET_REMINDER = "context-journal-budget";
export const ROLLOVER_TEXT = "Context window rolled over without an LLM-generated summary. The full append-only session transcript remains available with context_history. The durable context_notes below contain the working checkpoint; verify its claims against files and history. Preserve the complete user objective and constraints, and continue unfinished work. This boundary is not evidence that the task is complete.";
/** Saved notes as the model sees them, or empty text without notes. */
export const notesContext = (state: Journal) => Object.keys(state.notes).length ? redactText(journalPrompt(state), knownSecretValues()) : "";
export const STALE_TEXT = "These notes may predate the latest work: retrieve recent messages with context_history before continuing.";
/** The compaction summary restates notes once, so requests never append them after the newest message. */
export const rolloverSummary = (state: Journal, stale = false) => `${ROLLOVER_TEXT}${stale ? ` ${STALE_TEXT}` : ""}\n\n${notesContext(state)}`;
const needsFollowUp = (message: any) => message?.role === "assistant" && Array.isArray(message.content) && message.content.some((part: any) => part?.type === "toolCall");

type Notice = "reminder" | "checkpoint";
const NOTICES: Record<Notice, string> = {
  reminder: "Context is approaching its working limit. Update durable context_notes now with the full objective, constraints, evidence and unfinished work, then request context_rollover at a safe stopping point. Older history remains retrievable.",
  checkpoint: "The 90% working context budget is exhausted. Use the remaining checkpoint reserve only for context_notes write/delete and context_rollover. Preserve the full objective, constraints, evidence and unfinished work. Other tools are blocked.",
};
/** Budget notices already persisted in the current context cycle. */
function sentNotices(entries: readonly any[]): Set<string> {
  const sent = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "compaction") break;
    if (entry?.type === "custom_message" && entry.customType === BUDGET_REMINDER && typeof entry.details?.notice === "string") sent.add(entry.details.notice);
  }
  return sent;
}

export type BudgetPhase = "unknown" | "normal" | "reminder" | "checkpoint" | "exhausted";
export function contextBudget(usage: Pick<ContextUsage, "tokens" | "contextWindow"> | undefined) {
  const window = usage?.contextWindow;
  if (!window || !Number.isFinite(window) || window <= 0 || usage?.tokens == null || !Number.isFinite(usage.tokens) || usage.tokens < 0) return { phase: "unknown" as BudgetPhase };
  const normal = Math.floor(window * 0.9);
  const hard = Math.min(Math.floor(window * 0.98), normal + 16384);
  const reminder = normal - Math.min(6144, Math.floor(window * 0.1));
  const phase: BudgetPhase = usage.tokens >= hard ? "exhausted" : usage.tokens >= normal ? "checkpoint" : usage.tokens >= reminder ? "reminder" : "normal";
  return { phase, normal, hard, remaining: Math.max(0, normal - usage.tokens), emergencyRemaining: Math.max(0, hard - usage.tokens) };
}

export function installRollover(pi: ExtensionAPI, journal: () => Journal) {
  let requested = false;
  let compacting = false;
  let exhaustedNotified = false;
  let notices = new Set<string>();
  let generation = 0;
  let activeContext: ExtensionContext | undefined;
  let acceptedCheckpoint: string | undefined;
  let staleAccepted = false;
  const reset = (_event?: unknown, ctx?: ExtensionContext) => {
    generation++; requested = false; compacting = false; exhaustedNotified = false; activeContext = undefined; acceptedCheckpoint = undefined; staleAccepted = false;
    notices = ctx ? sentNotices(ctx.sessionManager.getBranch()) : new Set();
  };
  pi.on("session_start", reset); pi.on("session_tree", reset); pi.on("session_shutdown", reset);
  const hasNotes = () => Object.keys(journal().notes).length > 0;
  const ready = (ctx: ExtensionContext) => hasNotes() ? currentCheckpoint(ctx.sessionManager.getBranch(), acceptedCheckpoint) : undefined;
  const boundaryDraft = (stale: boolean) => ({ type: "compaction" as const, summary: rolloverSummary(journal(), stale), firstKeptEntryId: null, details: { contextJournal: 1, noSummary: true, ...(stale ? { stale: true } : {}) } });
  /** User-driven recovery may accept stale notes; the model's own request never does. */
  const rollover = async (ctx: ExtensionContext, allowStale = false) => {
    if (!journal().enabled || compacting || !ctx.isIdle()) return;
    const checkpoint = ready(ctx);
    if (!checkpoint && !(allowStale && hasNotes())) {
      requested = false; acceptedCheckpoint = undefined;
      throw new Error("Save current objective, constraints and unfinished work with context_notes before rollover. Existing notes are missing or stale.");
    }
    acceptedCheckpoint = checkpoint; staleAccepted = !checkpoint;
    requested = true; compacting = true; activeContext = ctx;
    const version = generation;
    try {
      await new Promise<void>((resolve, reject) => ctx.compact({ onComplete: () => resolve(), onError: reject }));
    } catch (error) { if (version === generation) throw error; }
    finally { if (version === generation) { requested = false; compacting = false; activeContext = undefined; acceptedCheckpoint = undefined; staleAccepted = false; } }
  };
  pi.registerTool({ name: "context_rollover", label: "Roll context window",
    description: "Request no-summary context rollover after saving complete, current context_notes. During an active tool chain, end this response after requesting; Pi commits the boundary before settlement and continues with saved notes, or rolls over at its next safe automatic compaction boundary. History stays retrievable. This does not finish the task.",
    parameters: Type.Object({ checkpoint_ready: Type.Literal(true) }),
    async execute(_id, _params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (!journal().enabled) throw new Error("Enable /context-journal on first.");
      const checkpoint = ready(ctx);
      if (!checkpoint) throw new Error("Save a fresh context_notes checkpoint covering recent work before requesting rollover.");
      acceptedCheckpoint = checkpoint;
      requested = true;
      return { content: [{ type: "text", text: "Rollover requested. End this response now; saved notes and full history will be available after the safe compaction boundary. Do not mark the task complete." }], details: {} };
    },
  });
  pi.on("tool_call", (event, ctx) => {
    if (!journal().enabled) return;
    const budget = contextBudget(ctx.getContextUsage());
    if (requested) return { block: true, terminate: true, reason: "Context rollover is pending. End the current tool batch so Pi can commit its safe boundary." };
    const checkpointTool = event.toolName === "context_rollover" || event.toolName === "context_notes" && ["write", "delete"].includes(String(event.input.action));
    // Not terminating lets turn_end commit a rollover and continue the run.
    if (budget.phase === "exhausted" && !checkpointTool) {
      return { block: true, reason: hasNotes() ? "Emergency context budget exhausted. Pi rolls over to the saved notes after this turn." : "Emergency context budget exhausted. Write a context_notes checkpoint with the full objective, evidence, constraints and remaining work now." };
    }
    if (budget.phase === "checkpoint" && !(event.toolName === "context_rollover" || event.toolName === "context_notes" && ["write", "delete"].includes(String(event.input.action)))) {
      return { block: true, reason: "Context working budget exhausted. Only context_notes write/delete and context_rollover are allowed: checkpoint the full objective, evidence, constraints and remaining work, then roll over." };
    }
  });
  // Each budget notice is persisted once per context cycle after a completed
  // turn, so the request prefix stays cacheable and the notice stays visible.
  pi.on("turn_end", (event, ctx) => {
    if (!journal().enabled || requested || compacting || event.outcome !== "completed") return;
    const phase = contextBudget(ctx.getContextUsage()).phase;
    // A spent reserve during a tool chain rolls over to any saved notes, marked
    // stale without a fresh checkpoint. Completed responses wait for input.
    if (phase === "exhausted" && needsFollowUp(event.message)) {
      if (hasNotes()) {
        const stale = !ready(ctx);
        exhaustedNotified = false; notices.clear();
        return { entries: [...event.entries, boundaryDraft(stale)], continue: true };
      }
      // Stop this run once; the next prompt still reaches the model so it can save notes.
      ctx.abort();
      if (!exhaustedNotified) { exhaustedNotified = true; ctx.ui.notify("Emergency context budget exhausted without notes. Ask the model to save context_notes, or use native /compact.", "warning"); }
      return;
    }
    const notice: Notice | undefined = phase === "checkpoint" ? "checkpoint" : phase === "reminder" ? "reminder" : undefined;
    if (!notice || notices.has(notice)) return;
    notices.add(notice);
    return { entries: [...event.entries, { type: "custom_message" as const, customType: BUDGET_REMINDER, content: NOTICES[notice], display: false, details: { notice } }] };
  });
  pi.on("session_before_compact", (event, ctx) => {
    if (!journal().enabled) return compacting ? { cancel: true } : undefined;
    if (event.signal.aborted) return { cancel: true };
    // Ordinary /compact and overflow recovery retain Pi's default behavior.
    if (event.reason !== "threshold" && !requested) return;
    const stale = !ready(ctx);
    if (requested) {
      if (stale && !staleAccepted) return { cancel: true };
    } else {
      // Threshold compaction after a finished response rolls over to saved
      // notes; during a tool chain the checkpoint budget stays in charge.
      const last = event.branchEntries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      if (!hasNotes() || last?.type !== "message" || needsFollowUp(last.message)) return { cancel: true };
    }
    pi.appendEntry(ROLLOVER_BOUNDARY, { version: 1 });
    const firstKeptEntryId = ctx.sessionManager.getLeafId();
    if (!firstKeptEntryId) return { cancel: true };
    const draft = boundaryDraft(stale);
    return { compaction: { summary: draft.summary, firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: draft.details } };
  });
  pi.on("session_compact", () => { requested = false; exhaustedNotified = false; notices.clear(); acceptedCheckpoint = undefined; staleAccepted = false; });
  pi.on("agent_before_settle", (event, ctx) => {
    if (!requested || compacting || !journal().enabled) return;
    // Never turn an interruption/error into a context-only recovery request.
    // Another handler's new context must be consumed before notes can cover it.
    const checkpoint = ready(ctx);
    requested = false; acceptedCheckpoint = undefined;
    if (event.outcome !== "completed") return;
    if (!checkpoint || event.entries.some((entry) => entry.type !== "custom")) {
      ctx.ui.notify("Context rollover deferred because the checkpoint or boundary changed. Save updated notes before retrying.", "warning");
      return;
    }
    exhaustedNotified = false; notices.clear();
    return { entries: [...event.entries, boundaryDraft(false)], continue: true };
  });
  pi.on("input", async (_event, ctx) => {
    if (!journal().enabled || !ctx.isIdle() || compacting) return;
    const budget = contextBudget(ctx.getContextUsage());
    if (!requested && !["checkpoint", "exhausted"].includes(budget.phase)) return;
    try { await rollover(ctx, true); } catch { ctx.ui.notify("Context was not rolled over. Save notes or use native /compact; your input will still be submitted.", "warning"); }
  });
  return { rollover, checkpoint: () => pi.appendEntry(CHECKPOINT_ENTRY, { version: 1 }), disable: () => { requested = false; acceptedCheckpoint = undefined; activeContext?.abort(); }, status: () => requested ? "rollover pending" : "automatic" };
}
