import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { separatorText, type StepTiming } from "./format.ts";
import { isTelemetryStyle, telemetryStyle, TELEMETRY_CHANGED, RESPONSE_TIMING_EVENT } from "../../lib/telemetry.ts";

const ENTRY_TYPE = "worked-for-separator";
export const SEPARATOR_STATE_ENTRY = "turn-separator-state";

interface SeparatorEntry {
  seconds?: number;
  timing?: StepTiming;
  /** Old work-block entries remain readable without repeating their usage totals. */
  stats?: StepTiming;
}

export function loadSeparatorDefault(path = join(getAgentDir(), "turn-separator.json")): boolean {
  try { return JSON.parse(readFileSync(path, "utf8"))?.enabled === true; }
  catch { return false; }
}

function enabledOnBranch(entries: readonly any[], fallback: boolean): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === SEPARATOR_STATE_ENTRY
      && entry.data?.version === 1 && typeof entry.data.enabled === "boolean") return entry.data.enabled;
  }
  return fallback;
}

/** Optional timing between model steps; whole-turn usage belongs in turn-stats. */
export default function turnSeparatorExtension(
  pi: ExtensionAPI,
  now: () => number = () => performance.now(),
  defaultEnabled = loadSeparatorDefault(),
): void {
  let enabled = defaultEnabled;
  let stepStart: number | undefined;
  let didWork = false;
  let timing: StepTiming | undefined;
  let style = telemetryStyle([]);
  let sessionId: string | undefined;

  const reset = () => { stepStart = undefined; didWork = false; timing = undefined; };
  const unsubscribeStyle = pi.events?.on(TELEMETRY_CHANGED, (value: any) => {
    if (value?.sessionId === sessionId && isTelemetryStyle(value.style)) style = value.style;
  });
  const unsubscribeTiming = pi.events?.on(RESPONSE_TIMING_EVENT, (value: any) => {
    if (!enabled || value?.sessionId !== sessionId) return;
    timing = {
      ttftMs: Number.isFinite(value.ttftMs) && value.ttftMs >= 0 ? value.ttftMs : undefined,
      tps: Number.isFinite(value.tps) && value.tps >= 0 ? value.tps : undefined,
    };
  });

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => ({
    invalidate() {},
    render(width: number): string[] {
      if (!enabled || style === "hide") return [];
      const data = entry?.data as SeparatorEntry | undefined;
      const line = separatorText(data?.seconds, width, data?.timing ?? data?.stats, (text) => theme.fg("dim", text), visibleWidth);
      return line ? [line] : [];
    },
  }));

  const restore = (_event: unknown, ctx: any) => {
    reset();
    const entries = ctx?.sessionManager?.getBranch() ?? [];
    enabled = enabledOnBranch(entries, defaultEnabled);
    style = telemetryStyle(entries);
    sessionId = ctx?.sessionManager?.getSessionId?.();
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", () => {
    reset();
    sessionId = undefined;
    unsubscribeStyle?.();
    unsubscribeTiming?.();
  });
  pi.on("agent_settled", reset);

  pi.on("tool_execution_start", () => {
    if (!enabled) return;
    didWork = true;
    stepStart ??= now();
  });
  pi.on("message_start", (event) => {
    if (!enabled || event.message.role !== "assistant") return;
    const timestamp = now();
    if (didWork && stepStart !== undefined) {
      pi.appendEntry<SeparatorEntry>(ENTRY_TYPE, { seconds: Math.max(0, (timestamp - stepStart) / 1000), timing });
    }
    stepStart = timestamp;
    didWork = false;
    timing = undefined;
  });

  pi.registerCommand("turn-separator", {
    description: "Optional per-step timing: on|off|toggle|status (off by default)",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off", "toggle", "status"].filter((value) => value.startsWith(prefix.toLowerCase()));
      return values.length ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "toggle";
      if (action === "status") {
        ctx.ui.notify(`Step timing: ${enabled ? "on" : "off"}. Whole-turn totals remain available through /turn-stats.`, "info");
        return;
      }
      if (!["on", "off", "toggle"].includes(action)) {
        ctx.ui.notify("Usage: /turn-separator [on|off|toggle|status]", "info");
        return;
      }
      enabled = action === "toggle" ? !enabled : action === "on";
      reset();
      pi.appendEntry(SEPARATOR_STATE_ENTRY, { version: 1, enabled });
      ctx.ui.notify(`Step timing ${enabled ? "enabled" : "disabled"} for this branch.`, "info");
    },
  });
}
