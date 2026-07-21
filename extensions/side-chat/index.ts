import { complete } from "@earendil-works/pi-ai/compat";
import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { OVERLAY_MODAL_EVENT, registerOverlayCard } from "../overlay-stack/index.ts";
import {
  metaRecord,
  restoreSideChats,
  SIDE_META_ENTRY,
  SIDE_STATE_ENTRY,
  stateRecord,
} from "./persistence.ts";
import {
  buildSidePreamble,
  deriveTitle,
  MAX_OUTPUT_TOKENS,
  responseText,
  toApiMessages,
} from "./prompts.ts";
import { errorMessage, SideChatStore, type SideRunResult } from "./store.ts";
import { modelLabel, type SideChat, type SideContextMode, type SideModelRef } from "./types.ts";
import { formatSideUsage, normalizeSideUsage } from "./usage.ts";
import {
  renderPromotedMessage,
  renderSideCard,
  SideChatWorkspace,
  type WorkspaceCallbacks,
  type WorkspaceInitial,
} from "./ui.ts";

const COMMAND_NAME = "side";
const SHORTCUT = "ctrl+shift+s";
const SHORTCUT_LABEL = "Ctrl+Shift+S";
const PROMOTED_MESSAGE_TYPE = "side-chat-promoted";
const USAGE_STATUS_KEY = "side-chat-usage";
const WORKSPACE_MODAL_ID = "side-chat-workspace";
const DEFAULT_CONTEXT_MODE: SideContextMode = "snapshot";
const PROMOTE_LIMIT = 8 * 1024;

export interface SideChatExtensionOptions {
  registerCard?: typeof registerOverlayCard;
  contextMode?: SideContextMode;
}

export default function registerSideChat(pi: ExtensionAPI, options: SideChatExtensionOptions = {}): SideChatStore {
  const registerCard = options.registerCard ?? registerOverlayCard;
  const contextMode = options.contextMode ?? DEFAULT_CONTEXT_MODE;
  let activeContext: ExtensionContext | undefined;
  let workspaceRefresh: (() => void) | undefined;
  let workspaceCloser: (() => void) | undefined;
  const promotedTurns = new Map<string, number>();

  const runModel = async (chat: SideChat, signal: AbortSignal): Promise<SideRunResult> => {
    const ctx = activeContext;
    if (!ctx) throw new Error("Side chat has no active session");
    const model = ctx.modelRegistry.find(chat.model.provider, chat.model.id);
    if (!model) throw new Error(`Model ${modelLabel(chat.model)} is not available`);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);

    const response = await complete(
      model,
      { systemPrompt: chat.systemPrompt, messages: toApiMessages(chat) },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal,
        reasoning: "low",
        maxTokens: MAX_OUTPUT_TOKENS,
        sessionId: `${ctx.sessionManager.getSessionId()}:side:${chat.id}`,
      },
    );

    if (response.stopReason === "aborted" || signal.aborted) throw new Error("Side chat cancelled");
    if (response.stopReason === "error") throw new Error(response.errorMessage || "Side chat request failed");
    const text = responseText(response);
    if (!text) throw new Error("Side chat returned no text");
    return { text, usage: normalizeSideUsage(response.usage) };
  };

  const syncUsage = () => {
    if (!activeContext?.hasUI) return;
    const text = formatSideUsage(store.totalUsage());
    activeContext.ui.setStatus(USAGE_STATUS_KEY, text ? activeContext.ui.theme.fg("dim", text) : undefined);
  };

  const store = new SideChatStore({
    runModel,
    hooks: {
      onChange: () => {
        card?.invalidate();
        workspaceRefresh?.();
        syncUsage();
      },
      persistMeta: (chat) => pi.appendEntry(SIDE_META_ENTRY, metaRecord(chat)),
      persistState: (chat) => pi.appendEntry(SIDE_STATE_ENTRY, stateRecord(chat)),
      persistDelete: (chat) => pi.appendEntry(SIDE_STATE_ENTRY, stateRecord(chat, true)),
    },
  });

  const card = registerCard({
    id: "side-chat",
    order: 16,
    width: 54,
    minBodyHeight: 2,
    minTerminalWidth: 90,
    minTerminalHeight: 12,
    visible: () => store.activeCount() > 0,
    title: (theme) => {
      const active = store.activeCount();
      return `${theme.bold(" Side chats ")}${theme.fg("accent", `● ${active} generating `)}`;
    },
    renderBody: (width, maxHeight, theme) => renderSideCard(store.list(), width, maxHeight, theme),
  });

  const createChat = (ctx: ExtensionContext, seedQuestion?: string): SideChat => {
    if (!ctx.model) throw new Error("No model selected");
    const modelRef: SideModelRef = {
      provider: ctx.model.provider,
      id: ctx.model.id,
      api: ctx.model.api,
      name: ctx.model.name,
      contextWindow: ctx.model.contextWindow,
    };
    let conversation = "";
    if (contextMode === "snapshot") {
      try {
        const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
        conversation = serializeConversation(convertToLlm(context.messages));
      } catch {
        conversation = "";
      }
    }
    const preamble = buildSidePreamble({
      contextMode,
      conversation,
      mainSystemPrompt: safeSystemPrompt(ctx),
      modelContextWindow: ctx.model.contextWindow,
    });
    return store.create({
      model: modelRef,
      systemPrompt: preamble.systemPrompt,
      contextMode,
      contextTruncated: preamble.contextTruncated,
      title: seedQuestion ? deriveTitle(seedQuestion) : undefined,
    });
  };

  const safeCreate = (ctx: ExtensionContext, seedQuestion?: string): SideChat | undefined => {
    try {
      return createChat(ctx, seedQuestion);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
      return undefined;
    }
  };

  const promote = (id: string): string => {
    const chat = store.get(id);
    if (!chat) return "Side chat not found.";
    const lastAssistant = [...chat.turns].reverse().find((turn) => turn.role === "assistant");
    if (!lastAssistant) return "Nothing to promote yet — ask a question first.";
    if (promotedTurns.get(chat.id) === lastAssistant.timestamp) return "That side answer was already promoted.";
    promotedTurns.set(chat.id, lastAssistant.timestamp);
    const question = [...chat.turns].reverse().find((turn) => turn.role === "user");
    const content = bounded(
      [`Side question: ${question?.text ?? "(unknown)"}`, "", "Side answer:", lastAssistant.text].join("\n"),
      PROMOTE_LIMIT,
    );
    pi.sendMessage(
      {
        customType: PROMOTED_MESSAGE_TYPE,
        content,
        display: true,
        details: { chatId: chat.id, title: chat.title, model: lastAssistant.model ?? modelLabel(chat.model) },
      },
      { deliverAs: "nextTurn" },
    );
    return "Promoted the latest answer to the next main turn.";
  };

  const callbacks = (ctx: ExtensionContext): WorkspaceCallbacks => ({
    list: () => store.list(),
    onSend: (id, text) => {
      store.send(id, text);
    },
    onRetry: (id) => store.retry(id),
    onAbort: (id) => store.abort(id),
    onPromote: (id) => promote(id),
    onNew: () => safeCreate(ctx),
    onDelete: (id) => store.remove(id),
  });

  const openWorkspace = async (ctx: ExtensionContext, initial?: WorkspaceInitial): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("The side-chat workspace needs interactive TUI mode.", "warning");
      return;
    }
    pi.events.emit(OVERLAY_MODAL_EVENT, { id: WORKSPACE_MODAL_ID, open: true });
    try {
      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => {
          workspaceCloser = done;
          const workspace = new SideChatWorkspace(callbacks(ctx), theme, keybindings, tui, done, initial);
          workspaceRefresh = () => {
            workspace.refresh();
            tui.requestRender();
          };
          return workspace;
        },
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%", minWidth: 60, margin: 1 },
        },
      );
    } finally {
      workspaceRefresh = undefined;
      workspaceCloser = undefined;
      pi.events.emit(OVERLAY_MODAL_EVENT, { id: WORKSPACE_MODAL_ID, open: false });
    }
  };

  pi.registerMessageRenderer(PROMOTED_MESSAGE_TYPE, (message, _renderOptions, theme) =>
    renderPromotedMessage(typeof message.content === "string" ? message.content : "", theme),
  );

  pi.registerCommand(COMMAND_NAME, {
    description: "Open side chats — persistent, multi-turn side conversations that run alongside the main job",
    handler: async (args, ctx) => {
      activeContext = ctx;
      const question = args.trim();
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Side chats need interactive TUI mode.", "warning");
        return;
      }
      if (question) {
        const chat = safeCreate(ctx, question);
        if (!chat) return;
        store.send(chat.id, question);
        ctx.ui.notify(
          "Side chat \u201c" + chat.title + "\u201d is generating in the background. Open it with /side or " + SHORTCUT_LABEL + ".",
          "info",
        );
        return;
      }
      await openWorkspace(ctx, { mode: "list" });
    },
  });

  pi.registerShortcut(SHORTCUT, {
    description: "Toggle the side-chat workspace (chats keep running in the background)",
    handler: async (ctx) => {
      activeContext = ctx;
      if (workspaceCloser) {
        workspaceCloser();
        return;
      }
      await openWorkspace(ctx, { mode: "list" });
    },
  });

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    promotedTurns.clear();
    store.replaceAll(restoreSideChats(ctx.sessionManager.getBranch()));
    syncUsage();
  });

  pi.on("session_tree", (_event, ctx) => {
    activeContext = ctx;
    store.replaceAll(restoreSideChats(ctx.sessionManager.getBranch()));
    syncUsage();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    store.stopAll();
    workspaceRefresh = undefined;
    ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
    activeContext = undefined;
    card.unregister();
  });

  return store;
}

function safeSystemPrompt(ctx: ExtensionContext): string {
  try {
    return String(ctx.getSystemPrompt?.() ?? "");
  } catch {
    return "";
  }
}

function bounded(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
