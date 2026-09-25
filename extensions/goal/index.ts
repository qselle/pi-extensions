import { deferredTools } from "../../lib/deferred-tools.ts";
import { assertGoalIdentity, assertGoalReconciled, reconcileGoal, RECONCILIATION_STALL_REASON, requireGoalReconciliation, resumeGoalForRequest } from "./reconciliation.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  BLOCKED_AUDIT_TURNS,
  NO_TOOL_TURN_LIMIT,
  accountGoalUsage,
  beginGoalRun,
  clearGoalBlockerAudit,
  createGoal,
  currentGoalCheck,
  decodeGoalEntry,
  editGoalObjective,
  formatDuration,
  formatTokens,
  goalCheckProgress,
  goalChecksComplete,
  recordGoalBlocker,
  recordRunTools,
  reportGoalProgress,
  setGoalStatus,
  shouldConfirmReplacement,
  stallGoal,
  type GoalCheck,
  type GoalEntry,
  type GoalState,
} from "./goal.ts";
import {
  GOAL_COMPLETED_EVENT,
  GOAL_CHANGED_EVENT,
  GOAL_ATTENTION_EVENT,
  isGoalAttentionStatus,
  type GoalAttentionEvent,
  createGoalCompletedEvent,
} from "./events.ts";
import {
  CONTINUATION_MARKER_TEXT,
  CONTINUATION_MARKER_TYPE,
  GOAL_CONTEXT_MARKER_TEXT,
  GOAL_CONTEXT_MARKER_TYPE,
  buildBudgetLimitMessage,
  buildGoalContext,
  goalResponse,
} from "./prompts.ts";
import { OVERLAY_MODAL_EVENT, registerOverlayCard } from "../overlay-stack/index.ts";
import {
  GoalPanel,
  goalOverlayTitle,
  renderGoalOverlayBody,
  type GoalPanelAction,
} from "./ui.ts";

const ENTRY_TYPE = "goal-state";
const BUDGET_MESSAGE_TYPE = "goal-budget-limit";

interface GoalContextMessage {
  role: "custom";
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
  timestamp: number;
}

interface GoalToolDetails {
  action: "get" | "create" | "progress" | "update" | "reconcile" | "resume" | "clear";
  goal?: GoalState;
  message?: string;
  blockerCount?: number;
  blockerRequired?: number;
  duplicate?: boolean;
}

const GoalCheckParameters = Type.Object({
  content: Type.String({ description: "A concrete, verifiable progress check." }),
  status: StringEnum(["pending", "in_progress", "complete", "cancelled"] as const),
});
const GetGoalParameters = Type.Object({});
const GoalIdentityParameters = Type.Object({
  goal_id: Type.String({ description: "Current goal id from get_goal." }),
  request_id: Type.String({ description: "Current reconciliation request_id from get_goal or goal context." }),
});
const ReconcileGoalParameters = Type.Object({
  goal_id: Type.String({ description: "Current goal id from get_goal." }),
  request_id: Type.String({ description: "Current reconciliation request_id from get_goal or goal context." }),
  action: StringEnum(["keep", "revise", "pause"] as const),
  objective: Type.Optional(Type.String({ description: "For revise: the complete user-requested objective." })),
  checks: Type.Optional(Type.Array(GoalCheckParameters, { maxItems: 8, description: "For revise: the complete checks list; [] if none." })),
});
const CreateGoalParameters = Type.Object({
  objective: Type.String({ description: "The complete objective explicitly requested by the user." }),
  checks: Type.Optional(Type.Array(GoalCheckParameters, { maxItems: 8 })),
  token_budget: Type.Optional(Type.Integer({ minimum: 1, description: "Set only when the user explicitly requests a token budget." })),
});
const ReportGoalProgressParameters = Type.Object({
  checks: Type.Array(GoalCheckParameters, { maxItems: 8, description: "The complete current progress-check list." }),
  summary: Type.Optional(Type.String({ description: "A concise evidence-based progress update." })),
});
const UpdateGoalParameters = Type.Object({
  status: StringEnum(["complete", "blocked"] as const, {
    description: "Mark the active goal complete after verification, or report a concrete repeated blocker.",
  }),
  blocker: Type.Optional(Type.String({ description: "Required for blocked: the concrete condition preventing progress." })),
  condition_id: Type.Optional(Type.String({ description: "Stable blocker identifier, reused across runs even if wording or evidence changes. Change it only for a different underlying condition.", pattern: "^[a-zA-Z0-9_.:-]{1,120}$" })),
  evidence: Type.Optional(Type.String({ description: "Observed evidence for the blocker." })),
  next_input: Type.Optional(Type.String({ description: "User input or external change needed to unblock progress." })),
});

export default function goalExtension(pi: ExtensionAPI) {
  const controls = deferredTools(pi, ["get_goal", "report_goal_progress", "update_goal", "reconcile_goal", "resume_goal", "clear_goal"]);
  let goal: GoalState | undefined;
  let sessionGeneration = 0;
  let sessionOpen = false;
  let currentRequestId: string | undefined;
  let continuationTimer: ReturnType<typeof setTimeout> | undefined;
  let nextRunIsContinuation = false;
  let currentRunIsContinuation = false;
  let currentRunHadToolCall = false;
  let currentRunReportedBlocker = false;
  let currentRunRepeatedAssistant = false;
  let lastAssistantText: string | undefined;
  let agentRunning = false;
  let runGoalId: string | undefined;
  let runStartedAt: number | undefined;
  let pendingCompletion: { goalId: string; completionId: string; completedAt: number } | undefined;
  const accountedMessages = new WeakSet<object>();
  let savedGoalStatus: string | undefined;
  let pendingAttention: GoalAttentionEvent | undefined;
  let attentionQueued = false;

  const assertCurrentRequest = (goalId: string, requestId: string) => {
    if (!sessionOpen) throw new Error("The session changed. Read get_goal in the current session.");
    assertGoalIdentity(goal, goalId);
    if (!currentRequestId || requestId !== currentRequestId) {
      throw new Error("The user request changed. Read get_goal and use its current request_id.");
    }
  };

  const overlayCard = registerOverlayCard({
    id: "goal",
    order: 5,
    width: 58,
    minBodyHeight: 3,
    minTerminalWidth: 72,
    minTerminalHeight: 12,
    visible: () => Boolean(goal && goal.status !== "complete"),
    title: (theme) => goal ? goalOverlayTitle(goal, theme) : " Goal ",
    renderBody: (width, maxHeight, theme) => goal
      ? renderGoalOverlayBody(goal, width, maxHeight, theme, runStartedAt)
      : [],
  });

  const persist = () => {
    if (goal) controls.activate();
    pi.appendEntry<GoalEntry>(ENTRY_TYPE, { version: 2, goal: goal ?? null });
    pi.events.emit(GOAL_CHANGED_EVENT, { version: 1, status: goal?.status ?? "none" });
  };

  const save = (ctx?: ExtensionContext) => {
    persist();
    overlayCard.invalidate();
    const nextStatus = goal ? `${goal.id}:${goal.status}` : undefined;
    const changed = nextStatus !== savedGoalStatus;
    savedGoalStatus = nextStatus;
    if (!goal || !isGoalAttentionStatus(goal.status)) { pendingAttention = undefined; return; }
    const sessionId = ctx?.sessionManager.getSessionId?.();
    if (!changed || !sessionId) return;
    pendingAttention = {
      version: 1, attentionId: crypto.randomUUID(), sessionId, goalId: goal.id,
      status: goal.status, turns: goal.turns, tokensUsed: goal.tokensUsed, tokenBudget: goal.tokenBudget,
    };
    if (attentionQueued) return;
    attentionQueued = true;
    const generation = sessionGeneration;
    // One provider response can cross both budget and capacity limits. Report
    // its final state once, and never deliver into a replacement session.
    queueMicrotask(() => {
      if (generation !== sessionGeneration) return;
      attentionQueued = false;
      const event = pendingAttention; pendingAttention = undefined;
      if (event) pi.events.emit(GOAL_ATTENTION_EVENT, event);
    });
  };

  const emitPendingCompletion = () => {
    const pending = pendingCompletion;
    if (!pending) return;
    pendingCompletion = undefined;
    if (!goal || goal.id !== pending.goalId || goal.status !== "complete") return;
    pi.events.emit(
      GOAL_COMPLETED_EVENT,
      createGoalCompletedEvent(goal, pending.completionId, pending.completedAt),
    );
  };

  const stopContinuationTimer = () => {
    if (continuationTimer) clearTimeout(continuationTimer);
    continuationTimer = undefined;
  };

  const scheduleContinuation = (ctx: ExtensionContext) => {
    stopContinuationTimer();
    if (ctx.mode !== "tui" || !goal || goal.status !== "active" || goal.reconciliation) return;
    const expectedGoalId = goal.id;

    continuationTimer = setTimeout(() => {
      continuationTimer = undefined;
      if (
        !goal
        || goal.id !== expectedGoalId
        || goal.status !== "active"
        || goal.reconciliation
        || !ctx.isIdle()
        || ctx.hasPendingMessages()
      ) return;

      nextRunIsContinuation = true;
      try {
        // Persist only a hidden wake marker. The context hook must replace this
        // marker with the full prompt; dropping it would leave Codex with no input.
        pi.sendMessage(
          {
            customType: CONTINUATION_MARKER_TYPE,
            content: CONTINUATION_MARKER_TEXT,
            display: false,
            details: { goalId: expectedGoalId, transient: true },
          },
          { triggerTurn: true },
        );
      } catch (error) {
        nextRunIsContinuation = false;
        const reason = error instanceof Error ? error.message : String(error);
        goal = stallGoal(goal, `Automatic continuation could not start: ${reason}`);
        save(ctx);
        ctx.ui.notify("Goal stalled because its continuation could not start.", "error");
      }
    }, 25);
  };

  const createNewGoal = (
    objective: string,
    ctx: ExtensionContext,
    tokenBudget: number | null = null,
    initialTurn = false,
    checks: GoalCheck[] = [],
  ) => {
    goal = createGoal(objective, { tokenBudget, initialTurn, checks });
    currentRequestId = undefined;
    if (initialTurn) {
      runGoalId = goal.id;
      runStartedAt ??= Date.now();
    }
    save(ctx);
    return goal;
  };

  const pauseGoal = (ctx: ExtensionContext) => {
    if (!goal) {
      ctx.ui.notify("No goal is currently set.", "warning");
      return;
    }
    if (goal.status !== "active") {
      ctx.ui.notify(`The goal is ${goal.status.replace("_", " ")}, not active.`, "warning");
      return;
    }
    stopContinuationTimer();
    goal = { ...setGoalStatus(goal, "paused"), reconciliation: undefined };
    currentRequestId = undefined;
    save(ctx);
    ctx.ui.notify("Goal paused.", "info");
  };

  const resumeGoal = (ctx: ExtensionContext) => {
    if (!goal) {
      ctx.ui.notify("No goal is currently set.", "warning");
      return;
    }
    if (goal.status === "budget_limited" || goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
      ctx.ui.notify("The goal cannot resume because its token budget is exhausted.", "warning");
      return;
    }
    if (goal.status === "complete") {
      ctx.ui.notify("The goal is complete. Edit it or create a new goal instead.", "warning");
      return;
    }
    if (goal.status === "active") {
      if (goal.reconciliation) {
        goal = { ...goal, reconciliation: undefined, updatedAt: Date.now() };
        currentRequestId = undefined;
        save(ctx);
        ctx.ui.notify("Continuing the current goal.", "info");
        scheduleContinuation(ctx);
        return;
      }
      ctx.ui.notify("The goal is already active.", "info");
      return;
    }
    goal = { ...setGoalStatus(goal, "active"), reconciliation: undefined };
    currentRequestId = undefined;
    save(ctx);
    ctx.ui.notify("Goal resumed.", "info");
    scheduleContinuation(ctx);
  };

  const clearGoal = async (ctx: ExtensionCommandContext) => {
    if (!goal) {
      ctx.ui.notify("No goal is currently set.", "info");
      return;
    }
    const snapshot = goal;
    const generation = sessionGeneration;
    const confirmed = await ctx.ui.confirm("Clear goal?", "The goal card and automatic continuation will stop.");
    if (!confirmed) return;
    if (generation !== sessionGeneration || snapshot !== goal) return;
    stopContinuationTimer();
    goal = undefined;
    currentRequestId = undefined;
    save(ctx);
    ctx.ui.notify("Goal cleared.", "info");
  };

  const editGoal = async (ctx: ExtensionCommandContext) => {
    if (!goal) {
      ctx.ui.notify("No goal is currently set.", "warning");
      return;
    }
    const snapshot = goal;
    const generation = sessionGeneration;
    const edited = await ctx.ui.editor("Edit goal", goal.objective);
    if (edited === undefined) return;
    if (generation !== sessionGeneration || snapshot !== goal) return;
    try {
      const wasActive = goal.status === "active";
      goal = { ...editGoalObjective(goal, edited), reconciliation: undefined };
      currentRequestId = undefined;
      save(ctx);
      ctx.ui.notify("Goal updated.", "info");
      if (!wasActive && goal.status === "active") scheduleContinuation(ctx);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  };

  const setGoalFromCommand = async (objective: string, ctx: ExtensionCommandContext) => {
    const snapshot = goal;
    const generation = sessionGeneration;
    if (shouldConfirmReplacement(goal)) {
      const current = truncateToWidth(goal!.objective.replace(/\s+/g, " "), 120, "…");
      const replacement = truncateToWidth(objective.replace(/\s+/g, " "), 120, "…");
      const confirmed = await ctx.ui.confirm(
        "Replace current goal?",
        `Current: ${current}\n\nNew: ${replacement}`,
      );
      if (!confirmed) return;
    }
    if (generation !== sessionGeneration || snapshot !== goal) return;

    try {
      createNewGoal(objective, ctx);
      ctx.ui.notify("Goal active. Pi will continue working until it completes, blocks, pauses, or reaches its budget.", "info");
      scheduleContinuation(ctx);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  };

  const showGoalPanel = async (ctx: ExtensionCommandContext) => {
    const generation = sessionGeneration;
    if (!goal) {
      const objective = await ctx.ui.editor("Set goal", "");
      if (generation !== sessionGeneration || goal) return;
      if (objective?.trim()) await setGoalFromCommand(objective, ctx);
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.notify(goalResponse(goal), "info");
      return;
    }

    const snapshot = goal;
    pi.events.emit(OVERLAY_MODAL_EVENT, { id: "goal-panel", open: true });
    let action: GoalPanelAction;
    try {
      action = await ctx.ui.custom<GoalPanelAction>(
        (_tui, theme, _keybindings, done) => new GoalPanel(snapshot, theme, runStartedAt, done),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "60%",
            minWidth: 44,
            maxHeight: "80%",
          },
        },
      );
    } finally {
      pi.events.emit(OVERLAY_MODAL_EVENT, { id: "goal-panel", open: false });
    }

    if (generation !== sessionGeneration || snapshot !== goal) return;
    if (action === "edit") await editGoal(ctx);
    else if (action === "pause") pauseGoal(ctx);
    else if (action === "resume") resumeGoal(ctx);
    else if (action === "clear") await clearGoal(ctx);
  };

  pi.registerCommand("goal", {
    description: "Set or manage a persistent goal: /goal [<objective>|clear|edit|pause|resume]",
    getArgumentCompletions: (prefix) => {
      const commands = ["clear", "edit", "pause", "resume"];
      const items = commands
        .filter((command) => command.startsWith(prefix.toLowerCase()))
        .map((command) => ({ value: command, label: command }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const generation = sessionGeneration;
      stopContinuationTimer();
      try {
        const input = args.trim();
        if (!input) await showGoalPanel(ctx);
        else {
          switch (input.toLowerCase()) {
            case "clear": await clearGoal(ctx); break;
            case "edit": await editGoal(ctx); break;
            case "pause": pauseGoal(ctx); break;
            case "resume": resumeGoal(ctx); break;
            default: await setGoalFromCommand(input, ctx);
          }
        }
      } finally {
        if (generation === sessionGeneration && goal?.status === "active") scheduleContinuation(ctx);
      }
    },
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current persistent goal, status, elapsed time, token usage, and remaining budget.",
    parameters: GetGoalParameters,
    async execute() {
      return {
        content: [{ type: "text", text: goalResponse(goal) }],
        details: { action: "get", goal } satisfies GoalToolDetails,
      };
    },
    renderCall: (_args, theme) => toolHeading("Inspecting goal", theme),
    renderResult: (result, _options, theme) => renderGoalToolResult(result.details as GoalToolDetails | undefined, theme),
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a persistent self-continuing goal only when the user explicitly asks for one. Never infer a goal from an ordinary task. A token budget may be set only when the user explicitly requests it. Fails while an unfinished goal exists.",
    parameters: CreateGoalParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (pendingCompletion) {
        throw new Error("Cannot replace a completed goal until its current agent run settles.");
      }
      if (goal && goal.status !== "complete") {
        throw new Error("Cannot create a goal while an unfinished goal exists.");
      }
      const created = createNewGoal(
        params.objective,
        ctx,
        params.token_budget ?? null,
        agentRunning,
        (params.checks ?? []) as GoalCheck[],
      );
      return {
        content: [{ type: "text", text: goalResponse(created) }],
        details: { action: "create", goal: created, message: "Goal created" } satisfies GoalToolDetails,
      };
    },
    renderCall: (args, theme) => toolHeading("Creating goal", theme, args.objective),
    renderResult: (result, _options, theme) => renderGoalToolResult(result.details as GoalToolDetails | undefined, theme),
  });

  pi.registerTool({
    name: "reconcile_goal",
    label: "Reconcile Goal",
    description: "Reconcile the latest user request with the existing goal. Keep unchanged scope, including status questions; revise with the complete requested objective and checks; pause only at the user's explicit request to pause or cancel this objective. Use current goal_id and request_id. Preserve identity, history, usage and budget; inactive goals remain inactive until explicitly resumed.",
    parameters: ReconcileGoalParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      assertCurrentRequest(params.goal_id, params.request_id);
      assertGoalIdentity(goal, params.goal_id);
      goal = reconcileGoal(goal, params.request_id, params.action, { objective: params.objective, checks: params.checks as GoalCheck[] | undefined });
      if (goal.status !== "active") stopContinuationTimer();
      save(ctx);
      const message = params.action === "revise" ? "Goal revised" : params.action === "pause" ? "Goal paused" : "Goal scope kept";
      return { content: [{ type: "text", text: `${message}. ${goalResponse(goal)}` }], details: { action: "reconcile", goal, message } satisfies GoalToolDetails };
    },
    renderCall: (_args, theme) => toolHeading("Reconciling goal", theme),
    renderResult: (result, _options, theme) => renderGoalToolResult(result.details as GoalToolDetails | undefined, theme),
  });

  pi.registerTool({
    name: "resume_goal",
    label: "Resume Goal",
    description: "Resume an inactive goal only when the user explicitly asks to continue it. Preserve its objective, identity, history, usage and budget. Call reconcile_goal with the returned request_id before autonomous continuation. An exhausted budget cannot resume.",
    parameters: GoalIdentityParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      assertCurrentRequest(params.goal_id, params.request_id);
      assertGoalIdentity(goal, params.goal_id);
      goal = resumeGoalForRequest(goal);
      currentRequestId = goal.reconciliation!.requestId;
      if (agentRunning && runGoalId !== goal.id) {
        goal = beginGoalRun(goal, false);
        runGoalId = goal.id;
        runStartedAt = Date.now();
      }
      save(ctx);
      return { content: [{ type: "text", text: `Goal resumed; reconcile the latest request before continuing. ${goalResponse(goal)}` }], details: { action: "resume", goal, message: "Goal resumed; reconciliation pending" } satisfies GoalToolDetails };
    },
    renderCall: (_args, theme) => toolHeading("Resuming goal", theme),
    renderResult: (result, _options, theme) => renderGoalToolResult(result.details as GoalToolDetails | undefined, theme),
  });

  pi.registerTool({
    name: "clear_goal",
    label: "Clear Goal",
    description: "Clear an inactive goal only when the user explicitly cancels or replaces that objective. History remains saved. For an active goal, reconcile the request with action pause first. Never clear to claim success; use update_goal complete after verification.",
    parameters: GoalIdentityParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      assertCurrentRequest(params.goal_id, params.request_id);
      assertGoalIdentity(goal, params.goal_id);
      if (goal.status === "active" || goal.status === "complete") throw new Error("Only an inactive unfinished goal can be cleared with clear_goal.");
      stopContinuationTimer();
      goal = undefined;
      currentRequestId = undefined;
      save(ctx);
      return { content: [{ type: "text", text: goalResponse(goal) }], details: { action: "clear", message: "Goal cleared" } satisfies GoalToolDetails };
    },
    renderCall: (_args, theme) => toolHeading("Clearing goal", theme),
    renderResult: (result, _options, theme) => renderGoalToolResult(result.details as GoalToolDetails | undefined, theme),
  });

  pi.registerTool({
    name: "report_goal_progress",
    label: "Report Goal Progress",
    description: "Replace an active, reconciled goal's concise progress checks and summary. Keep checks concrete and evidence-based, with at most one in progress. This never resumes an inactive goal; use resume_goal only at the user's explicit request.",
    parameters: ReportGoalProgressParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!goal) throw new Error("No goal is currently set.");
      assertGoalReconciled(goal);
      goal = reportGoalProgress(goal, params.checks as GoalCheck[], params.summary);
      save(ctx);
      const progress = goalCheckProgress(goal);
      const message = `Goal progress ${progress.complete}/${progress.total}`;
      return {
        content: [{ type: "text", text: `${message}. ${goalResponse(goal)}` }],
        details: { action: "progress", goal, message } satisfies GoalToolDetails,
      };
    },
    renderCall: (_args, theme) => toolHeading("Updating goal progress", theme),
    renderResult: (result, _options, theme) => renderGoalToolResult(result.details as GoalToolDetails | undefined, theme),
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: `Mark the existing goal complete or report a genuine repeated blocker. Complete requires every non-cancelled progress check to be finished and a requirement-by-requirement verification showing no work remains. For blocked, provide blocker, evidence, and next_input; the same blocker must be reported in ${BLOCKED_AUDIT_TURNS} separate consecutive goal runs before the loop stops. Difficulty, uncertainty, or a preference for clarification is not a blocker.`,
    parameters: UpdateGoalParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!goal) throw new Error("No goal is currently set.");
      assertGoalReconciled(goal);

      if (params.status === "complete") {
        if (goal.status === "complete") throw new Error("The goal is already complete.");
        const finishingBudgetedRun = goal.status === "budget_limited" && agentRunning && runGoalId === goal.id;
        if (goal.status !== "active" && !finishingBudgetedRun) throw new Error("Only an active goal or its current budget-limited wrap-up can be completed. Resume only at the user's explicit request.");
        if (!goalChecksComplete(goal)) {
          const progress = goalCheckProgress(goal);
          throw new Error(`Cannot complete the goal: ${progress.total - progress.complete} progress check(s) remain unfinished.`);
        }
        const completedAt = Date.now();
        goal = setGoalStatus(goal, "complete", completedAt);
        pendingCompletion = {
          goalId: goal.id,
          completionId: crypto.randomUUID(),
          completedAt,
        };
        save(ctx);
        return {
          content: [{ type: "text", text: `Goal achieved. ${goalResponse(goal)}` }],
          details: { action: "update", goal, message: "Goal achieved" } satisfies GoalToolDetails,
        };
      }

      const outcome = recordGoalBlocker(
        goal,
        {
          conditionId: params.condition_id,
          description: params.blocker ?? "",
          evidence: params.evidence,
          nextInput: params.next_input,
        },
        goal.turns,
      );
      currentRunReportedBlocker = true;
      goal = outcome.goal;
      save(ctx);
      const audit = goal.blockerAudit!;
      const message = outcome.duplicate
        ? "Blocker already recorded in this run"
        : outcome.blocked
          ? "Goal blocked"
          : `Blocker recorded ${audit.count}/${BLOCKED_AUDIT_TURNS}; goal remains active`;
      return {
        content: [{ type: "text", text: `${message}. ${goalResponse(goal)}` }],
        details: {
          action: "update",
          goal,
          message,
          blockerCount: audit.count,
          blockerRequired: BLOCKED_AUDIT_TURNS,
          duplicate: outcome.duplicate,
        } satisfies GoalToolDetails,
      };
    },
    renderCall: (args, theme) => toolHeading(args.status === "complete" ? "Completing goal" : "Reporting blocker", theme),
    renderResult: (result, _options, theme) => renderGoalToolResult(result.details as GoalToolDetails | undefined, theme),
  });

  pi.on("before_agent_start", () => {
    if (!goal || goal.status === "complete") return;
    return {
      message: {
        customType: GOAL_CONTEXT_MARKER_TYPE,
        content: GOAL_CONTEXT_MARKER_TEXT,
        display: false,
        details: { goalId: goal.id, transient: true },
      },
    };
  });

  pi.on("context", (event) => {
    const messages = event.messages as Array<{ customType?: string }>;
    let latestGoalMarker = -1;
    let latestContinuationWake = -1;
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      const customType = message?.customType;
      if (customType === CONTINUATION_MARKER_TYPE || customType === GOAL_CONTEXT_MARKER_TYPE) {
        latestGoalMarker = index;
      }
      if (currentRunIsContinuation && isContinuationWakeMessage(message)) {
        latestContinuationWake = index;
      }
    }
    if (latestGoalMarker === -1 && latestContinuationWake === -1) return;

    const contextGoal = goal && goal.status !== "complete" ? goal : undefined;
    const transformed: typeof event.messages = [];
    for (let index = 0; index < event.messages.length; index++) {
      const message = event.messages[index]!;
      if (index === latestContinuationWake && contextGoal) {
        const wake = message as unknown as { content: unknown };
        const content = buildGoalContext(contextGoal, true);
        transformed.push({
          ...message,
          content: typeof wake.content === "string" ? content : [{ type: "text", text: content }],
        } as typeof message);
        continue;
      }

      const customType = (message as { customType?: string }).customType;
      if (customType !== CONTINUATION_MARKER_TYPE && customType !== GOAL_CONTEXT_MARKER_TYPE) {
        transformed.push(message);
        continue;
      }
      if (latestContinuationWake !== -1 || !contextGoal || index !== latestGoalMarker) continue;
      const marker = message as unknown as GoalContextMessage;
      transformed.push({
        ...marker,
        customType: GOAL_CONTEXT_MARKER_TYPE,
        content: buildGoalContext(contextGoal, currentRunIsContinuation),
        details: { goalId: contextGoal.id, transient: true },
      } as unknown as typeof message);
    }
    return { messages: transformed };
  });

  pi.on("input", (event, ctx) => {
    stopContinuationTimer();
    if (event.source === "interactive" || event.source === "rpc") {
      nextRunIsContinuation = false;
      if (goal && goal.status !== "complete") {
        goal = requireGoalReconciliation(goal);
        currentRequestId = goal.reconciliation!.requestId;
        save(ctx);
      }
    }
    return { action: "continue" };
  });

  pi.on("agent_start", (_event, ctx) => {
    agentRunning = true;
    currentRunIsContinuation = nextRunIsContinuation;
    nextRunIsContinuation = false;
    currentRunHadToolCall = false;
    currentRunReportedBlocker = false;
    currentRunRepeatedAssistant = false;
    runGoalId = goal?.status === "active" ? goal.id : undefined;
    runStartedAt = runGoalId ? Date.now() : undefined;

    if (goal && runGoalId === goal.id) {
      goal = beginGoalRun(goal, currentRunIsContinuation);
      save(ctx);
    }
  });

  pi.on("tool_execution_end", () => {
    if (runGoalId) currentRunHadToolCall = true;
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || accountedMessages.has(message)) return;
    accountedMessages.add(message);

    const text = assistantMessageText(message);
    if (text) {
      if (currentRunIsContinuation && text === lastAssistantText) {
        currentRunRepeatedAssistant = true;
      }
      lastAssistantText = text;
    }

    if (!runGoalId || !goal || goal.id !== runGoalId) return;

    const previousStatus = goal.status;
    goal = accountGoalUsage(goal, { tokens: message.usage.totalTokens });
    save(ctx);

    if (previousStatus === "active" && goal.status === "budget_limited") {
      pi.sendMessage(
        {
          customType: BUDGET_MESSAGE_TYPE,
          content: buildBudgetLimitMessage(goal),
          display: false,
        },
        { deliverAs: "steer" },
      );
    }

    if (message.stopReason === "aborted" && goal.status === "active") {
      goal = setGoalStatus(goal, "paused");
      save(ctx);
      ctx.ui.notify("Goal paused because the agent run was interrupted.", "warning");
    } else if (message.stopReason === "error") {
      const usageLimited = isUsageLimitError(message.errorMessage);
      const canStop = goal.status === "active" || (goal.status === "budget_limited" && usageLimited);
      if (canStop) {
        const detail = message.errorMessage?.trim() || "Unknown provider error";
        goal = usageLimited
          ? { ...setGoalStatus(goal, "usage_limited"), stallReason: `Provider unavailable: ${detail}` }
          : stallGoal(goal, `Agent run failed: ${detail}`);
        save(ctx);
        ctx.ui.notify(`Goal ${usageLimited ? "waiting for provider capacity" : "stalled after an agent error"}.`, "warning");
      }
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (runStartedAt !== undefined && runGoalId && goal?.id === runGoalId) {
      goal = accountGoalUsage(goal, { timeMs: Date.now() - runStartedAt });
      if (goal.status === "active" && !goal.reconciliation) {
        if (currentRunIsContinuation) {
          goal = recordRunTools(goal, currentRunHadToolCall);
          if (!currentRunHadToolCall && currentRunRepeatedAssistant) {
            goal = stallGoal(
              goal,
              "Automatic continuation repeated the previous assistant response without any tool activity.",
            );
            ctx.ui.notify("Goal stalled after the continuation replayed the previous response.", "warning");
          } else if (goal.noToolTurns >= NO_TOOL_TURN_LIMIT) {
            goal = stallGoal(
              goal,
              `Automatic continuation paused after ${NO_TOOL_TURN_LIMIT} runs made no tool call or terminal goal update.`,
            );
            ctx.ui.notify("Goal stalled after repeated empty continuations. Resume to retry.", "warning");
          }
        }
        if (goal.status === "active" && goal.blockerAudit && !currentRunReportedBlocker) {
          goal = clearGoalBlockerAudit(goal);
        }
      }
      save(ctx);
    }
    emitPendingCompletion();

    if (goal?.reconciliation && goal.status === "active") {
      goal = stallGoal(goal, RECONCILIATION_STALL_REASON);
      save(ctx);
      ctx.ui.notify("Goal stalled: the latest request was not reconciled. Use /goal resume to keep this objective, or /goal edit or clear.", "warning");
    } else if (goal?.reconciliation) {
      ctx.ui.notify("Goal reconciliation is still pending. Use /goal resume to keep this objective, or /goal edit or clear.", "info");
    }

    agentRunning = false;
    runGoalId = undefined;
    runStartedAt = undefined;
    currentRunIsContinuation = false;
    currentRunHadToolCall = false;
    currentRunReportedBlocker = false;
    currentRunRepeatedAssistant = false;
    overlayCard.invalidate();
    scheduleContinuation(ctx);
  });

  const restore = (ctx: ExtensionContext) => {
    controls.initialize();
    sessionGeneration++;
    sessionOpen = true;
    currentRequestId = undefined;
    goal = undefined;
    lastAssistantText = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        lastAssistantText = assistantMessageText(entry.message) ?? lastAssistantText;
        continue;
      }
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const restored = decodeGoalEntry(entry.data);
      if (restored) goal = restored.goal ?? undefined;
    }
    if (goal) controls.activate();
    savedGoalStatus = goal ? `${goal.id}:${goal.status}` : undefined;
    pendingAttention = undefined;
    attentionQueued = false;
    // Keep pending work across reload/branch changes while invalidating tool
    // calls prepared against the previous live session.
    if (goal?.reconciliation) {
      goal = { ...goal, reconciliation: { ...goal.reconciliation, requestId: crypto.randomUUID() }, updatedAt: Date.now() };
      currentRequestId = goal.reconciliation!.requestId;
      save(ctx);
      ctx.ui.notify("Goal reconciliation is pending. Use /goal resume to keep this objective, or /goal edit or clear.", "info");
    }
    pi.events.emit(GOAL_CHANGED_EVENT, { version: 1, status: goal?.status ?? "none" });
    agentRunning = false;
    runGoalId = undefined;
    runStartedAt = undefined;
    pendingCompletion = undefined;
    nextRunIsContinuation = false;
    currentRunIsContinuation = false;
    currentRunHadToolCall = false;
    currentRunReportedBlocker = false;
    currentRunRepeatedAssistant = false;
    overlayCard.invalidate();
    scheduleContinuation(ctx);
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_compact", () => overlayCard.invalidate());
  pi.on("session_shutdown", () => {
    sessionGeneration++;
    sessionOpen = false;
    currentRequestId = undefined;
    stopContinuationTimer();
    if (runStartedAt !== undefined && runGoalId && goal?.id === runGoalId) {
      goal = accountGoalUsage(goal, { timeMs: Date.now() - runStartedAt });
      persist();
    }
    emitPendingCompletion();
    overlayCard.unregister();
  });
}

function toolHeading(label: string, theme: Theme, detail?: string) {
  const suffix = detail ? ` ${theme.fg("dim", truncateToWidth(detail.replace(/\s+/g, " "), 80, "…"))}` : "";
  return new Text(`${theme.fg("accent", "◆")} ${theme.fg("toolTitle", theme.bold(label))}${suffix}`, 0, 0);
}

function renderGoalToolResult(details: GoalToolDetails | undefined, theme: Theme) {
  if (!details?.goal) return new Text(theme.fg("dim", details?.message ?? "No goal is set"), 0, 0);
  const state = details.goal;
  const title = details.message ?? `Goal ${state.status.replace("_", " ")}`;
  const usage = state.tokenBudget === null
    ? formatDuration(state.timeUsedMs)
    : `${formatTokens(state.tokensUsed)} / ${formatTokens(state.tokenBudget)} tokens`;
  const progress = goalCheckProgress(state);
  const current = currentGoalCheck(state);
  const preview = details.action === "progress" && current
    ? current.content
    : state.objective;
  const progressText = (progress.total > 0 ? `${progress.complete}/${progress.total} · ` : "")
    + (progress.cancelled > 0 ? `${progress.cancelled} cancelled · ` : "");
  const symbol = state.status === "blocked" || state.status === "usage_limited"
    ? theme.fg("error", "!")
    : state.status === "budget_limited" || state.status === "stalled"
      ? theme.fg("warning", "■")
      : theme.fg("success", "✓");
  return new Text(
    `${symbol} ${theme.fg("muted", title)}\n`
      + `${theme.fg("dim", "└")} ${truncateToWidth(preview.replace(/\s+/g, " "), 100, "…")} ${theme.fg("dim", `· ${progressText}${usage}`)}`,
    0,
    0,
  );
}

function assistantMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || undefined;
}

function isContinuationWakeMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "user") return false;
  if (candidate.content === CONTINUATION_MARKER_TEXT) return true;
  if (!Array.isArray(candidate.content) || candidate.content.length !== 1) return false;
  const part = candidate.content[0];
  return Boolean(
    part
    && typeof part === "object"
    && (part as { type?: unknown }).type === "text"
    && (part as { text?: unknown }).text === CONTINUATION_MARKER_TEXT
  );
}

function isUsageLimitError(message: string | undefined): boolean {
  return Boolean(message && /\b(usage limit|rate limit|quota|too many requests|billing|credit|service unavailable|temporarily unavailable|429|503)\b/i.test(message));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
