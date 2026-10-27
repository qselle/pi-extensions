import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeLegacySummary, decodeSummary, emptySummary, recordExtraUsage, recordResponse, summaryText, type Summary } from "./stats.ts";
import { addTiming, isFirstOutputEvent } from "./timing.ts";
import { renderCompletion } from "./render.ts";
import { pricingEstimator } from "../footer/usage.ts";
import { isTelemetryStyle, telemetryStyle, TELEMETRY_ENTRY, TELEMETRY_CHANGED, RESPONSE_TIMING_EVENT } from "../../lib/telemetry.ts";
const ENTRY = "turn-usage-summary";
/** Per-turn totals written by older sessions; rendered read-only. */
const LEGACY_ENTRY = "turn-stats";

function storedSummary(entry: { type: string; customType?: string; data?: unknown }): Summary | undefined {
  if (entry.type !== "custom") return;
  if (entry.customType === ENTRY) return decodeSummary(entry.data);
  if (entry.customType === LEGACY_ENTRY) return decodeLegacySummary(entry.data);
}
/** Full agent-run accounting, separate from individual response/work-block timing. */
export default function turnStats(pi: ExtensionAPI, now: () => number = () => performance.now(), wallNow: () => number = Date.now): void {
  let current: Summary | undefined;
  let started = 0;
  let seen = new WeakSet<object>();
  let sent: number | undefined;
  let first: number | undefined;
  let style = telemetryStyle([]);
  const reset = () => { current = undefined; seen = new WeakSet(); sent = undefined; first = undefined; };
  const restore = (_event: unknown, ctx: any) => { reset(); style = telemetryStyle(ctx?.sessionManager?.getBranch() ?? []); };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", reset);
  pi.on("agent_start", () => {
    // Native retries, compaction and pre-settle continuations can start the agent
    // again before the same user turn settles. Keep the whole turn's accounting.
    if (!current) { current = emptySummary(); started = now(); }
  });
  pi.on("before_provider_request", () => { if (current) { sent = now(); first = undefined; } });
  pi.on("message_update", (event) => {
    if (!current || sent === undefined || first !== undefined) return;
    if (isFirstOutputEvent(event.assistantMessageEvent)) first = now();
  });
  pi.on("tool_execution_start", () => { if (current) current.tools++; });
  pi.on("tool_execution_end", (event) => { if (current && event.isError) current.failedTools++; });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (!current || seen.has(message)) return;
    if (message.role === "toolResult") {
      seen.add(message);
      recordExtraUsage(current, message.usage);
      return;
    }
    if (message.role !== "assistant") return;
    seen.add(message);
    // Some providers record tokens with a zero cost; price those from the model's rates, as the footer does.
    const estimate = ctx?.modelRegistry ? pricingEstimator((provider, model) => ctx.modelRegistry.find(provider, model)) : undefined;
    recordResponse(current, message, estimate && ((usage) => estimate({ type: "message", message }, usage)));
    const timing = addTiming(current.timing!, sent, first, now(), message.usage?.output);
    // Every finalized response publishes once, including missing timing, so
    // optional step rules cannot inherit measurements from an earlier reply.
    pi.events?.emit(RESPONSE_TIMING_EVENT, { sessionId: ctx?.sessionManager?.getSessionId?.(), ...timing });
    sent = undefined; first = undefined;
  });
  // Compaction during the run is billed to it, as in the footer's session totals.
  pi.on("session_compact", (event) => { if (current) recordExtraUsage(current, event.compactionEntry?.usage); });
  pi.on("agent_settled", () => {
    if (!current) return;
    const summary = current;
    summary.durationMs = Math.max(0, now() - started);
    summary.endedAt = wallNow();
    reset();
    if (summary.responses || summary.tools) pi.appendEntry(ENTRY, summary);
  });
  for (const customType of [ENTRY, LEGACY_ENTRY]) pi.registerEntryRenderer(customType, (entry, options, theme) => ({
    invalidate() {},
    render(width) {
      const summary = storedSummary(entry);
      if (!summary || width <= 0 || style === "hide") return [];
      return renderCompletion(summary, width, theme, options.expanded || style === "full", entry.timestamp);
    },
  }));
  pi.registerCommand("turn-stats", {
    description: "Show recorded totals; compact|full|hide controls transcript telemetry for this session branch",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (isTelemetryStyle(action)) {
        pi.appendEntry(TELEMETRY_ENTRY, { version: 1, style: action }); style = action;
        pi.events?.emit(TELEMETRY_CHANGED, { sessionId: ctx.sessionManager.getSessionId(), style });
        ctx.ui.notify(`Transcript telemetry: ${style}. Accounting and /turn-stats remain available.`, "info");
        return;
      }
      if (action) { ctx.ui.notify("Usage: /turn-stats [compact|full|hide]", "info"); return; }
      const summary = current ? { ...current, durationMs: Math.max(0, now() - started) }
        : [...ctx.sessionManager.getBranch()].reverse().map(storedSummary).find(Boolean);
      ctx.ui.notify(summary ? summaryText(summary, true, Boolean(current)) : "No turn statistics recorded on this branch.", "info");
    },
  });
}
