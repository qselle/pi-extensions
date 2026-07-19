export interface ParentSessionContext {
  messages: any[];
}

/** Remove the unresolved assistant tool-call batch that is currently spawning a child. */
export function safeParentMessages(context: ParentSessionContext): any[] {
  const messages = [...context.messages];
  const resolved = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message: any = messages[index];
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      resolved.add(message.toolCallId);
      continue;
    }
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const calls = message.content.filter((part: any) => part?.type === "toolCall");
    if (calls.length === 0) return messages;
    const unresolved = calls.some((part: any) => typeof part.id !== "string" || !resolved.has(part.id));
    return unresolved ? messages.slice(0, index) : messages;
  }
  return messages;
}
