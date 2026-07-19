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
  action: "get" | "create" | "progress" | "update";
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
  evidence: Type.Optional(Type.String({ description: "Observed evidence for the blocker." })),
  next_input: Type.Optional(Type.String({ description: "User input or external change needed to unblock progress." })),
});

export default function goalExtension(pi: ExtensionAPI) {
  let goal: GoalState | undefined;
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
  const accountedMessages = new WeakSet<object>();

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
    pi.appendEntry<GoalEntry>(ENTRY_TYPE, { version: 2, goal: goal ?? null });
  };

  const save = (_ctx?: ExtensionContext) => {
    persist();
    overlayCard.invalidate();
  };

  const stopContinuationTimer = () => {
    if (continuationTimer) clearTimeout(continuationTimer);
    continuationTimer = undefined;
  };

  const scheduleContinuation = (ctx: ExtensionContext) => {
    stopContinuationTimer();
    if (ctx.mode !== "tui" || !goal || goal.status !== "active") return;
    const expectedGoalId = goal.id;

    continuationTimer = setTimeout(() => {
      continuationTimer = undefined;
      if (
        !goal
        || goal.id !== expectedGoalId
        || goal.status !== "active"
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
    goal = setGoalStatus(goal, "paused");
    save(ctx);
    ctx.ui.notify("Goal paused.", "info");
  };

  const resumeGoal = (ctx: ExtensionContext) => {
    if (!goal) {
      ctx.ui.notify("No goal is currently set.", "warning");
      return;
    }
    if (goal.status === "budget_limited") {
      ctx.ui.notify("The goal cannot resume because its token budget is exhausted.", "warning");
      return;
    }
    if (goal.status === "complete") {
      ctx.ui.notify("The goal is complete. Edit it or create a new goal instead.", "warning");
      return;
    }
    if (goal.status === "active") {
      ctx.ui.notify("The goal is already active.", "info");
      return;
    }
    goal = setGoalStatus(goal, "active");
    save(ctx);
    ctx.ui.notify("Goal resumed.", "info");
    scheduleContinuation(ctx);
  };

  const clearGoal = async (ctx: ExtensionCommandContext) => {
    if (!goal) {
      ctx.ui.notify("No goal is currently set.", "info");
      return;
    }
    const confirmed = await ctx.ui.confirm("Clear goal?", "The goal card and automatic continuation will stop.");
    if (!confirmed) return;
    stopContinuationTimer();
    goal = undefined;
    save(ctx);
    ctx.ui.notify("Goal cleared.", "info");
  };

  const editGoal = async (ctx: ExtensionCommandContext) => {
    if (!goal) {
      ctx.ui.notify("No goal is currently set.", "warning");
      return;
    }
    const edited = await ctx.ui.editor("Edit goal", goal.objective);
    if (edited === undefined) return;
    try {
      const wasActive = goal.status === "active";
      goal = editGoalObjective(goal, edited);
      save(ctx);
      ctx.ui.notify("Goal updated.", "info");
      if (!wasActive && goal.status === "active") scheduleContinuation(ctx);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  };

  const setGoalFromCommand = async (objective: string, ctx: ExtensionCommandContext) => {
    if (shouldConfirmReplacement(goal)) {
      const current = truncateToWidth(goal!.objective.replace(/\s+/g, " "), 120, "…");
      const replacement = truncateToWidth(objective.replace(/\s+/g, " "), 120, "…");
      const confirmed = await ctx.ui.confirm(
        "Replace current goal?",
        `Current: ${current}\n\nNew: ${replacement}`,
      );
      if (!confirmed) return;
    }

    try {
      createNewGoal(objective, ctx);
      ctx.ui.notify("Goal active. Pi will continue working until it completes, blocks, pauses, or reaches its budget.", "info");
      scheduleContinuation(ctx);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  };

  const showGoalPanel = async (ctx: ExtensionCommandContext) => {
    if (!goal) {
      const objective = await ctx.ui.editor("Set goal", "");
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
        if (goal?.status === "active") scheduleContinuation(ctx);
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
    name: "report_goal_progress",
    label: "Report Goal Progress",
    description: "Replace an active or stalled goal's concise progress-check list and summary. A progress report automatically revives a stalled goal because it proves implementation is continuing. Keep checks concrete and evidence-based, with at most one in progress. Use this only for an explicit goal, not ordinary tasks.",
    parameters: ReportGoalProgressParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!goal) throw new Error("No goal is currently set.");
      const resumed = goal.status === "stalled";
      const reportableGoal = resumed ? setGoalStatus(goal, "active") : goal;
      let nextGoal = reportGoalProgress(reportableGoal, params.checks as GoalCheck[], params.summary);
      if (resumed && agentRunning && runGoalId !== nextGoal.id) {
        nextGoal = beginGoalRun(nextGoal, false);
        runGoalId = nextGoal.id;
        runStartedAt = Date.now();
      }
      goal = nextGoal;
      save(ctx);
      const progress = goalCheckProgress(goal);
      const message = `${resumed ? "Goal resumed; " : ""}goal progress ${progress.complete}/${progress.total}`;
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

      if (params.status === "complete") {
        if (!goalChecksComplete(goal)) {
          const progress = goalCheckProgress(goal);
          throw new Error(`Cannot complete the goal: ${progress.total - progress.complete} progress check(s) remain unfinished.`);
        }
        goal = setGoalStatus(goal, "complete");
        save(ctx);
        return {
          content: [{ type: "text", text: `Goal achieved. ${goalResponse(goal)}` }],
          details: { action: "update", goal, message: "Goal achieved" } satisfies GoalToolDetails,
        };
      }

      const outcome = recordGoalBlocker(
        goal,
        {
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
    if (!goal || (goal.status !== "active" && goal.status !== "stalled")) return;
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

    const contextGoal = goal && (goal.status === "active" || goal.status === "stalled") ? goal : undefined;
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

  pi.on("input", () => {
    stopContinuationTimer();
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
      if (goal.status === "active") {
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
    agentRunning = false;
    runGoalId = undefined;
    runStartedAt = undefined;
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
    stopContinuationTimer();
    if (runStartedAt !== undefined && runGoalId && goal?.id === runGoalId) {
      goal = accountGoalUsage(goal, { timeMs: Date.now() - runStartedAt });
      persist();
    }
    overlayCard.unregister();
  });
}

function toolHeading(label: string, theme: Theme, detail?: string) {
  const suffix = detail ? ` ${theme.fg("dim", truncateToWidth(detail.replace(/\s+/g, " "), 80, "…"))}` : "";
  return new Text(`${theme.fg("accent", "◆")} ${theme.fg("toolTitle", theme.bold(label))}${suffix}`, 0, 0);
}

function renderGoalToolResult(details: GoalToolDetails | undefined, theme: Theme) {
  if (!details?.goal) return new Text(theme.fg("dim", "No goal is set"), 0, 0);
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
  const progressText = progress.total > 0 ? `${progress.complete}/${progress.total} · ` : "";
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
