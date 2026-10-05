/**
 * Hidden "anchor" messages restate extension state (a plan, a goal) for the
 * model, but only when the visible conversation no longer shows that state.
 *
 * Restating state on every request, or appending it after the newest message,
 * moves the provider's prompt-cache breakpoint and leaves the history uncached.
 * Anchors are instead persisted once as hidden custom messages, after events that
 * hide earlier state: compaction, branch navigation, session restore, or a state
 * change the model did not make itself. Equal states must render equal text so a
 * restore path can tell that the model already sees the current state.
 */

/** Structural view of a model-visible message. */
export interface VisibleMessage {
  role?: unknown;
  customType?: unknown;
  content?: unknown;
  toolName?: unknown;
  isError?: unknown;
  details?: unknown;
}

export interface AnchorHost {
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): unknown;
}

export interface AnchorContext {
  sessionManager: { buildSessionProjection?: () => { messages: readonly unknown[] } };
}

export interface ContextAnchorOptions<T> {
  /** Custom message type of persisted anchors. */
  customType: string;
  /** Deterministic text restating `state` for the model. */
  render(state: T): string;
  /** Text equivalent of a non-anchor message that already shows a state, such as a tool result. */
  readMessage?(message: VisibleMessage): string | undefined;
  /** Text the model implicitly assumes when nothing visible restates the state. */
  emptyText?: string;
}

export interface ContextAnchor<T> {
  /** Text of the newest visible state in `messages`, or the empty text. */
  visibleText(messages: readonly unknown[]): string;
  /**
   * Persist one hidden anchor when the model cannot see `state`. Returns whether
   * an anchor was sent. Without a readable session projection nothing is sent,
   * because a duplicate anchor would cost a cache miss for no benefit.
   */
  sync(host: AnchorHost, ctx: AnchorContext, state: T, details?: unknown): boolean;
}

/** Plain text of message content, or undefined when it holds non-text parts. */
export function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  let text = "";
  for (const part of content) {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text") return undefined;
    const value = (part as { text?: unknown }).text;
    if (typeof value !== "string") return undefined;
    text += value;
  }
  return text;
}

/** Model-visible messages after compaction and context edits, if the host exposes them. */
export function visibleMessages(ctx: AnchorContext): readonly unknown[] | undefined {
  try {
    return ctx.sessionManager.buildSessionProjection?.().messages;
  } catch {
    return undefined;
  }
}

export function createContextAnchor<T>(options: ContextAnchorOptions<T>): ContextAnchor<T> {
  const emptyText = options.emptyText ?? "";
  const visibleText = (messages: readonly unknown[]): string => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index] as VisibleMessage | undefined;
      if (!message || typeof message !== "object") continue;
      if (message.role === "custom" && message.customType === options.customType) {
        const text = contentText(message.content);
        if (text !== undefined) return text;
        continue;
      }
      const text = options.readMessage?.(message);
      if (text !== undefined) return text;
    }
    return emptyText;
  };
  return {
    visibleText,
    sync(host, ctx, state, details) {
      const messages = visibleMessages(ctx);
      if (!messages) return false;
      const text = options.render(state);
      if (visibleText(messages) === text) return false;
      host.sendMessage(
        { customType: options.customType, content: text, display: false, ...(details === undefined ? {} : { details }) },
        { deliverAs: "steer" },
      );
      return true;
    },
  };
}
