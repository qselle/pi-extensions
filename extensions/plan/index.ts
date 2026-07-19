import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { OVERLAY_MODAL_EVENT, registerOverlayCard } from "../overlay-stack/index.ts";
import {
  MAX_PLAN_ITEMS,
  createPlanState,
  decodePlanEntry,
  planIsActive,
  planResponse,
  replacePlan,
  type PlanEntry,
  type PlanItem,
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
  renderPlanText,
  type PlanPanelAction,
} from "./ui.ts";

const ENTRY_TYPE = "plan-state";

const PlanItemParameters = Type.Object({
  step: Type.String({ description: "A concise, concrete execution step." }),
  status: StringEnum(["pending", "in_progress", "completed", "cancelled"] as const),
});

const UpdatePlanParameters = Type.Object({
  explanation: Type.Optional(Type.String({ description: "A short rationale when the plan changes." })),
  plan: Type.Array(PlanItemParameters, {
    maxItems: MAX_PLAN_ITEMS,
    description: "The complete current plan. This replaces the previous list.",
  }),
});

interface UpdatePlanInput {
  explanation?: string;
  plan: PlanItem[];
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

  const overlayCard = registerOverlayCard({
    id: "plan",
    order: 10,
    width: 58,
    minBodyHeight: 1,
    minTerminalWidth: 72,
    minTerminalHeight: 12,
    visible: () => planIsActive(plan),
    title: (theme) => planOverlayTitle(plan, theme),
    renderBody: (width, maxHeight, theme) => renderPlanOverlayBody(plan, width, maxHeight, theme),
  });

  const persist = () => {
    const entry: PlanEntry = { version: 1, plan };
    pi.appendEntry(ENTRY_TYPE, entry);
  };

  const save = () => {
    persist();
    overlayCard.invalidate();
  };

  const clearPlan = async (ctx: ExtensionCommandContext) => {
    if (plan.items.length === 0) {
      ctx.ui.notify("No plan is set.", "info");
      return;
    }
    const confirmed = await ctx.ui.confirm("Clear plan?", "The tactical execution plan will be removed.");
    if (!confirmed) return;
    plan = createPlanState();
    save();
    ctx.ui.notify("Plan cleared.", "info");
  };

  const showPlanPanel = async (ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(planResponse(plan), "info");
      return;
    }

    pi.events.emit(OVERLAY_MODAL_EVENT, { id: "plan-panel", open: true });
    let action: PlanPanelAction;
    try {
      action = await ctx.ui.custom<PlanPanelAction>(
        (_tui, theme, _keybindings, done) => new PlanPanel(plan, theme, done),
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
      pi.events.emit(OVERLAY_MODAL_EVENT, { id: "plan-panel", open: false });
    }

    if (action === "clear") await clearPlan(ctx);
  };

  pi.registerCommand("plan", {
    description: "Inspect or clear the current tactical execution plan: /plan [status|clear]",
    getArgumentCompletions: (prefix) => {
      const commands = ["status", "clear"];
      const items = commands
        .filter((command) => command.startsWith(prefix.toLowerCase()))
        .map((command) => ({ value: command, label: command }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (!command) await showPlanPanel(ctx);
      else if (command === "status") ctx.ui.notify(plan.items.length > 0 ? renderPlanText(plan) : "No plan is set.", "info");
      else if (command === "clear") await clearPlan(ctx);
      else ctx.ui.notify("Usage: /plan [status|clear]", "error");
    },
  });

  pi.registerTool({
    name: "update_plan",
    label: "Update Plan",
    description: "Create or replace the tactical execution plan for meaningful multi-step work.",
    parameters: UpdatePlanParameters,
    promptGuidelines: PLAN_PROMPT_GUIDELINES,
    async execute(_toolCallId, params: UpdatePlanInput) {
      plan = replacePlan(plan, params.plan, params.explanation);
      save();
      return {
        content: [{ type: "text", text: planToolResponse(plan) }],
        details: { plan } satisfies PlanToolDetails,
      };
    },
    renderCall: (_args, theme) => new Text(`${theme.fg("accent", "◆")} ${theme.bold("Updating plan")}`, 0, 0),
    renderResult: (result, _options, theme) => {
      const details = result.details as PlanToolDetails | undefined;
      return new PlanToolResult(details?.plan ?? createPlanState(), theme);
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
    plan = createPlanState();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const restored = decodePlanEntry(entry.data);
      if (restored) plan = restored.plan;
    }
    overlayCard.invalidate();
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_compact", () => overlayCard.invalidate());
  pi.on("session_shutdown", () => overlayCard.unregister());
}
