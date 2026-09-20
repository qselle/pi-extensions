import type { ExtensionAPI, ExtensionContext, ContextUsage } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Journal } from "./state.ts";
import { CHECKPOINT_ENTRY, currentCheckpoint, ROLLOVER_BOUNDARY } from "./checkpoint.ts";

export { ROLLOVER_BOUNDARY } from "./checkpoint.ts";
export const BUDGET_REMINDER = "context-journal-budget";
export const ROLLOVER_TEXT = "Context window rolled over without an LLM-generated summary. The full append-only session transcript remains available with context_history. Durable context_notes contain the working checkpoint; verify its claims against files and history. Preserve the complete user objective and constraints, and continue unfinished work. This boundary is not evidence that the task is complete.";
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
  let warned = false;
  let exhaustedNotified = false;
  let generation = 0;
  let activeContext: ExtensionContext | undefined;
  let acceptedCheckpoint: string | undefined;
  const reset = () => { generation++; requested = false; compacting = false; warned = false; exhaustedNotified = false; activeContext = undefined; acceptedCheckpoint = undefined; };
  pi.on("session_start", reset); pi.on("session_tree", reset); pi.on("session_shutdown", reset);
  const ready = (ctx: ExtensionContext) => Object.keys(journal().notes).length > 0 ? currentCheckpoint(ctx.sessionManager.getBranch(), acceptedCheckpoint) : undefined;
  const rollover = async (ctx: ExtensionContext) => {
    if (!journal().enabled || compacting || !ctx.isIdle()) return;
    const checkpoint = ready(ctx);
    if (!checkpoint) {
      requested = false; acceptedCheckpoint = undefined;
      throw new Error("Save current objective, constraints and unfinished work with context_notes before rollover. Existing notes are missing or stale.");
    }
    acceptedCheckpoint = checkpoint;
    requested = true; compacting = true; activeContext = ctx;
    const version = generation;
    try {
      await new Promise<void>((resolve, reject) => ctx.compact({ onComplete: () => resolve(), onError: reject }));
    } catch (error) { if (version === generation) throw error; }
    finally { if (version === generation) { requested = false; compacting = false; activeContext = undefined; acceptedCheckpoint = undefined; } }
  };
  pi.registerTool({ name: "context_rollover", label: "Roll context window",
    description: "Request no-summary context rollover after saving complete, current context_notes. During an active tool chain, end this response after requesting; rollover commits when the run settles, or at Pi's next safe automatic compaction boundary. History stays retrievable. This does not finish the task.",
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
    if (budget.phase === "exhausted") {
      ctx.abort();
      return { block: true, terminate: true, reason: "Emergency context budget exhausted. Work stopped before another tool ran. Review notes and use /context-journal reset." };
    }
    if (budget.phase === "checkpoint" && !(event.toolName === "context_rollover" || event.toolName === "context_notes" && ["write", "delete"].includes(String(event.input.action)))) {
      return { block: true, reason: "Context working budget exhausted. Only context_notes write/delete and context_rollover are allowed: checkpoint the full objective, evidence, constraints and remaining work, then roll over." };
    }
  });
  pi.on("context", (event, ctx) => {
    if (!journal().enabled) return;
    const budget = contextBudget(ctx.getContextUsage());
    let text: string | undefined;
    if (budget.phase === "exhausted") {
      ctx.abort();
      if (!exhaustedNotified) { exhaustedNotified = true; ctx.ui.notify("Emergency context budget exhausted. Review saved notes, then /context-journal reset.", "warning"); }
    } else if (requested) text = "Context rollover is pending. End this response; do not run more tools or claim completion. Continue unfinished work after the boundary.";
    else if (budget.phase === "checkpoint") text = "The 90% working context budget is exhausted. Use the remaining checkpoint reserve only for context_notes write/delete and context_rollover. Preserve the full objective, constraints, evidence and unfinished work. Other tools are blocked.";
    else if (budget.phase === "reminder" && !warned) { warned = true; text = "Context is approaching its working limit. Update durable context_notes now with the full objective, constraints, evidence and unfinished work, then request context_rollover at a safe stopping point. Older history remains retrievable."; }
    const messages = event.messages.filter((message) => !("customType" in message && message.customType === BUDGET_REMINDER));
    if (text) messages.push({ role: "custom", customType: BUDGET_REMINDER, content: text, display: false, timestamp: Date.now() } as typeof messages[number]);
    return { messages };
  });
  pi.on("session_before_compact", (event, ctx) => {
    if (!journal().enabled) return compacting ? { cancel: true } : undefined;
    if (event.signal.aborted) return { cancel: true };
    // Ordinary /compact and overflow recovery retain Pi's default behavior.
    if (event.reason !== "threshold" && !requested) return;
    if (!requested) return { cancel: true };
    if (!ready(ctx)) return { cancel: true };
    pi.appendEntry(ROLLOVER_BOUNDARY, { version: 1 });
    const firstKeptEntryId = ctx.sessionManager.getLeafId();
    if (!firstKeptEntryId) return { cancel: true };
    return { compaction: { summary: ROLLOVER_TEXT, firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: { contextJournal: 1, noSummary: true } } };
  });
  pi.on("session_compact", () => { requested = false; warned = false; exhaustedNotified = false; acceptedCheckpoint = undefined; });
  pi.on("agent_settled", async (_event, ctx) => {
    if (!requested || compacting || !journal().enabled) return;
    try { await rollover(ctx); } catch { ctx.ui.notify("Context rollover could not finish. Notes remain saved; retry /context-journal reset when idle.", "warning"); }
  });
  pi.on("input", async (_event, ctx) => {
    if (!journal().enabled || !ctx.isIdle() || compacting) return;
    const budget = contextBudget(ctx.getContextUsage());
    if (!requested && !["checkpoint", "exhausted"].includes(budget.phase)) return;
    try { await rollover(ctx); } catch { ctx.ui.notify("Context was not rolled over. Save a checkpoint or use native /compact; your input will still be submitted.", "warning"); }
  });
  return { rollover, checkpoint: () => pi.appendEntry(CHECKPOINT_ENTRY, { version: 1 }), disable: () => { requested = false; warned = false; acceptedCheckpoint = undefined; activeContext?.abort(); }, status: () => requested ? "rollover pending" : "automatic" };
}
