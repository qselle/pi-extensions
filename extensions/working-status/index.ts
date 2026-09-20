import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkingState, toolLabel } from "./state.ts";
import { indicatorStyle, isWorkingStyle, STYLE_ENTRY, WORKING_STYLES, type WorkingStyle } from "./style.ts";

export default function workingStatusExtension(pi: ExtensionAPI): void {
  const state = new WorkingState();
  let active: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let last: string | undefined;
  let style: WorkingStyle = "native";

  const refresh = () => {
    const label = state.label(performance.now());
    if (!active || label === last) return;
    active.ui.setWorkingMessage(label);
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
  const start = (ctx: ExtensionContext) => {
    stop();
    if (ctx.mode !== "tui") return;
    active = ctx;
    active.ui.setWorkingIndicator(indicatorStyle(style));
    state.start(performance.now());
    refresh();
    timer = setInterval(refresh, 1000);
    timer.unref?.();
  };

  const restore = (ctx: ExtensionContext) => {
    stop();
    style = "native";
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
  pi.on("message_update", (event) => {
    const type = event.assistantMessageEvent.type;
    if (type === "thinking_delta") state.phase = "Thinking";
    else if (type === "text_delta") state.phase = "Writing";
    else return;
    refresh();
  });
  pi.on("tool_execution_start", (event) => {
    if (!active) return;
    state.tools.set(event.toolCallId, toolLabel(event.toolName));
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
  pi.on("session_compact", () => {
    state.phase = "Working";
    refresh();
  });
  pi.on("session_compact_failed", () => {
    state.phase = "Working";
    refresh();
  });
  pi.on("agent_settled", stop);
  pi.on("session_shutdown", stop);
}
