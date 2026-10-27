import { keyText, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkingState, isRetryStatus, toolActivity, toolLabel } from "./state.ts";
import { indicatorStyle, isWorkingStyle, STYLE_ENTRY, WORKING_STYLES, type WorkingStyle } from "./style.ts";

export default function workingStatusExtension(pi: ExtensionAPI): void {
  const state = new WorkingState();
  let active: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let last: string | undefined;
  let style: WorkingStyle = "pulse";
  let hint = "";

  const refresh = () => {
    const label = state.label(performance.now());
    if (!active || label === last) return;
    active.ui.setWorkingMessage(label === undefined ? undefined : label + hint);
    last = label;
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (active) {
      active.ui.setWorkingMessage();
      active.ui.setWorkingIndicator();
    }
    active = undefined;
    last = undefined;
    state.reset();
  };
  /** Pi re-emits agent_start for retries, compaction recovery, and continuations; one run lasts until agent_settled. */
  const start = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return stop();
    if (active && state.startedAt !== undefined) state.resume();
    else {
      stop();
      state.start(performance.now());
      timer = setInterval(refresh, 1000);
      timer.unref?.();
    }
    active = ctx;
    hint = interruptHint(ctx);
    active.ui.setWorkingIndicator(indicatorStyle(style));
    last = undefined;
    refresh();
  };

  const restore = (ctx: ExtensionContext) => {
    stop();
    style = "pulse";
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STYLE_ENTRY) continue;
      const data = entry.data as { version?: unknown; style?: unknown } | undefined;
      if (data?.version === 1 && isWorkingStyle(data.style)) style = data.style;
    }
    if (!ctx.isIdle()) start(ctx);
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.registerCommand("working-style", {
    description: "Choose the working indicator: native, pulse, static or text",
    getArgumentCompletions: (prefix) => {
      const items = WORKING_STYLES.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (!requested) return ctx.ui.notify(`Working style: ${style}. Use /working-style native|pulse|static|text.`, "info");
      if (!isWorkingStyle(requested)) return ctx.ui.notify("Use /working-style native|pulse|static|text.", "warning");
      pi.appendEntry(STYLE_ENTRY, { version: 1, style: requested });
      style = requested;
      active?.ui.setWorkingIndicator(indicatorStyle(style));
      ctx.ui.notify(`Working style: ${style} (saved for this session branch).`, "info");
    },
  });
  pi.on("agent_start", (_event, ctx) => start(ctx));
  pi.on("before_provider_request", () => {
    state.phase = "Waiting for model";
    refresh();
  });
  pi.on("after_provider_response", (event) => {
    if (!isRetryStatus(event.status)) return;
    state.phase = "Retrying";
    refresh();
  });
  // The response has started: the provider is no longer just being waited on.
  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    state.phase = "Thinking";
    refresh();
  });
  pi.on("message_update", (event) => {
    const update = event.assistantMessageEvent;
    if (update.type === "thinking_delta") state.phase = "Thinking";
    else if (update.type === "text_delta") state.phase = "Writing";
    else if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
      const block = update.partial.content[update.contentIndex];
      state.phase = `Preparing ${toolLabel(block?.type === "toolCall" ? block.name : "")}`;
    } else return;
    refresh();
  });
  pi.on("tool_execution_start", (event) => {
    if (!active) return;
    state.tools.set(event.toolCallId, toolActivity(event.toolName, event.args));
    refresh();
  });
  pi.on("tool_execution_end", (event) => {
    state.tools.delete(event.toolCallId);
    state.phase = "Working";
    refresh();
  });
  pi.on("session_before_compact", () => {
    state.phase = "Compacting context";
    refresh();
  });
  pi.on("session_compact", (event) => {
    state.phase = event.willRetry ? "Retrying" : "Working";
    refresh();
  });
  pi.on("session_compact_failed", () => {
    state.phase = "Working";
    refresh();
  });
  pi.on("agent_settled", stop);
  pi.on("session_shutdown", stop);
}

/** Pi's working row normally names the interrupt key; keep that hint, dimmed, after the phase and time. */
function interruptHint(ctx: ExtensionContext): string {
  let key = "";
  try {
    key = keyText("app.interrupt");
  } catch { /* Keybindings are unavailable outside the interactive host. */ }
  if (!key) return "";
  const text = ` · ${key} to interrupt`;
  try {
    return ctx.ui.theme ? ctx.ui.theme.fg("dim", text) : text;
  } catch {
    return text;
  }
}
