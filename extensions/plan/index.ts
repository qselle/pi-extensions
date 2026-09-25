import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { toolText } from "../../lib/tool-ui.ts";
import { PlainOutput } from "../../lib/output.ts";
import { OVERLAY_MODAL_EVENT, registerOverlayCard } from "../overlay-stack/index.ts";
import {
  MAX_PLAN_ITEMS,
  MAX_PLAN_DEPTH,
  MAX_PLAN_DESCRIPTION_CHARS,
  createPlanState,
  decodePlanEntry,
  planIsActive,
  planResponse,
  replacePlan,
  type PlanEntry,
  type PlanItemInput,
  type PlanState,
} from "./plan.ts";
import {
  PLAN_CONTEXT_TYPE,
  PLAN_PROMPT_GUIDELINES,
  buildPlanContext,
  planToolResponse,
} from "./prompts.ts";
import {
  PlanPanel,
  PlanToolResult,
  planOverlayTitle,
  renderPlanOverlayBody,
  renderPlanSummary,
  renderPlanText,
  type PlanPanelAction,
} from "./ui.ts";

const ENTRY_TYPE = "plan-state";
const VIEW_ENTRY_TYPE = "plan-view";
type PlanView = "compact" | "card" | "hide";

const itemParameters = (depth: number): TSchema => Type.Object({
  step: Type.String({ description: "A concise execution step or group name." }),
  description: Type.Optional(Type.String({ maxLength: MAX_PLAN_DESCRIPTION_CHARS, description: "Optional useful context or verification details. Keep the step title concise." })),
  status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "cancelled"] as const, { description: "Required for leaf steps. Group status is derived from children." })),
  ...(depth < MAX_PLAN_DEPTH ? { children: Type.Optional(Type.Array(itemParameters(depth + 1), { minItems: 1, maxItems: MAX_PLAN_ITEMS })) } : {}),
});
const PlanItemParameters = itemParameters(1);

const UpdatePlanParameters = Type.Object({
  explanation: Type.Optional(Type.String({ description: "A short rationale when the plan changes." })),
  reset: Type.Optional(Type.Boolean({ description: "Start over only when the user changed the objective. Requires an explanation; otherwise preserve completed milestones in the unfinished plan." })),
  plan: Type.Array(PlanItemParameters, {
    maxItems: MAX_PLAN_ITEMS,
    description: "The complete current plan, with optional nested children. Up to 3 levels and 40 total nodes. Exactly one leaf step is in progress while work remains. Keep completed milestones at their existing group paths until the plan is finished or explicitly reset.",
  }),
});

interface UpdatePlanInput {
  explanation?: string;
  reset?: boolean;
  plan: PlanItemInput[];
}

interface PlanToolDetails {
  plan: PlanState;
}

interface TransientPlanMessage {
  role: "custom";
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
  timestamp: number;
}

export default function planExtension(pi: ExtensionAPI): void {
  let plan = createPlanState();
  let generation = 0;
  let view: PlanView = "compact";

  const overlayCard = registerOverlayCard({
    id: "plan",
    order: 10,
    width: 48,
    minBodyHeight: 1,
    minTerminalWidth: 72,
    minTerminalHeight: 12,
    visible: () => view !== "hide" && planIsActive(plan),
    presentation: () => view === "compact" ? "line" : "card",
    renderSummary: (width, theme) => renderPlanSummary(plan, width, theme),
    title: (theme) => planOverlayTitle(plan, theme),
    renderBody: (width, maxHeight, theme) => renderPlanOverlayBody(plan, width, maxHeight, theme),
  });

  const commit = (next: PlanState) => {
    const entry: PlanEntry = { version: next.items.some((item) => item.children) ? 2 : 1, plan: next };
    pi.appendEntry(ENTRY_TYPE, entry);
    plan = next;
    overlayCard.invalidate();
  };

  const clearPlan = async (ctx: ExtensionCommandContext) => {
    if (plan.items.length === 0) {
      ctx.ui.notify("No plan is set.", "info");
      return;
    }
    const version = generation;
    const snapshot = plan;
    const confirmed = await ctx.ui.confirm("Clear plan?", "The tactical execution plan will be removed.");
    if (!confirmed || version !== generation) return;
    if (snapshot !== plan) { ctx.ui.notify("Plan changed while confirming. Review the current plan before clearing it.", "warning"); return; }
    commit(createPlanState());
    ctx.ui.notify("Plan cleared.", "info");
  };

  const showPlanPanel = async (ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(planResponse(plan), "info");
      return;
    }

    const version = generation;
    const snapshot = plan;
    pi.events.emit(OVERLAY_MODAL_EVENT, { id: "plan-panel", open: true });
    let action: PlanPanelAction;
    try {
      action = await ctx.ui.custom<PlanPanelAction>(
        (tui, theme, _keybindings, done) => new PlanPanel(plan, theme, done, () => tui.requestRender(), () => tui.terminal.rows),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "62%",
            minWidth: 44,
            maxHeight: "82%",
          },
        },
      );
    } finally {
      if (version === generation) pi.events.emit(OVERLAY_MODAL_EVENT, { id: "plan-panel", open: false });
    }

    if (version === generation && snapshot === plan && action === "clear") await clearPlan(ctx);
  };

  pi.registerCommand("plan", {
    description: "Inspect the plan or choose its display: /plan [compact|card|hide|status|clear]",
    getArgumentCompletions: (prefix) => {
      const commands = ["compact", "card", "hide", "status", "clear"];
      const items = commands
        .filter((command) => command.startsWith(prefix.toLowerCase()))
        .map((command) => ({ value: command, label: command }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (!command) await showPlanPanel(ctx);
      else if (command === "compact" || command === "card" || command === "hide") {
        pi.appendEntry(VIEW_ENTRY_TYPE, { version: 1, view: command });
        view = command;
        overlayCard.invalidate();
        ctx.ui.notify(`Plan display: ${view === "hide" ? "hidden" : view}.`, "info");
      }
      else if (command === "status") ctx.ui.notify(plan.items.length > 0 ? renderPlanText(plan) : "No plan is set.", "info");
      else if (command === "clear") await clearPlan(ctx);
      else ctx.ui.notify("Usage: /plan [compact|card|hide|status|clear]", "error");
    },
  });

  pi.registerTool({
    name: "update_plan",
    label: "Update Plan",
    description: "Create or replace the tactical execution plan for meaningful multi-step work.",
    parameters: UpdatePlanParameters,
    promptGuidelines: PLAN_PROMPT_GUIDELINES,
    async execute(_toolCallId, params: UpdatePlanInput) {
      commit(replacePlan(plan, params.plan, params.explanation, undefined, params.reset));
      return {
        content: [{ type: "text", text: planToolResponse(plan) }],
        details: { plan } satisfies PlanToolDetails,
      };
    },
    renderShell: "self",
    renderCall: () => new Text("", 0, 0),
    renderResult: (result, options, theme, context) => {
      if (context?.isError) return toolText(theme.fg("error", new PlainOutput().push(result.content.filter(part => part.type === "text").map(part => part.text).join("\n")).slice(0, 1200)), true);
      if (options.isPartial) return new Text(theme.fg("accent", "• Updating plan…"), 0, 0);
      const details = result.details as PlanToolDetails | undefined;
      return new PlanToolResult(details?.plan ?? createPlanState(), theme, options.expanded);
    },
  });

  pi.on("context", (event) => {
    const activePlan = planIsActive(plan) ? plan : undefined;
    const transformed: typeof event.messages = [];
    for (const message of event.messages) {
      if ((message as { customType?: string }).customType !== PLAN_CONTEXT_TYPE) transformed.push(message);
    }
    if (!activePlan) {
      return transformed.length === event.messages.length ? undefined : { messages: transformed };
    }

    transformed.push({
      role: "custom",
      customType: PLAN_CONTEXT_TYPE,
      content: buildPlanContext(activePlan),
      display: false,
      details: { transient: true },
      timestamp: Date.now(),
    } as unknown as TransientPlanMessage as typeof event.messages[number]);
    return { messages: transformed };
  });

  const restore = (ctx: ExtensionContext) => {
    generation++;
    plan = createPlanState();
    view = "compact";
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === VIEW_ENTRY_TYPE) {
        const saved = entry.data as { version?: unknown; view?: unknown } | null;
        if (saved?.version === 1 && (saved.view === "compact" || saved.view === "card" || saved.view === "hide")) view = saved.view;
      }
      if (entry.customType !== ENTRY_TYPE) continue;
      const restored = decodePlanEntry(entry.data);
      if (restored) plan = restored.plan;
    }
    overlayCard.invalidate();
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_compact", () => overlayCard.invalidate());
  pi.on("session_shutdown", () => { generation++; overlayCard.unregister(); });
}
