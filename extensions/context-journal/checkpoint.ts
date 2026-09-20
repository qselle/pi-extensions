export const CHECKPOINT_ENTRY = "context-journal-checkpoint";
export const ROLLOVER_BOUNDARY = "context-journal-boundary";
const CHECKPOINT_TOOLS = new Set(["context_notes", "context_budget", "context_rollover"]);

/** A checkpoint covers work before its marker, never work in a later cycle. */
export function currentCheckpoint(entries: readonly any[], accepted?: string): string | undefined {
  let workAfter = false;
  let newWork = false;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "compaction" || entry?.type === "custom" && entry.customType === ROLLOVER_BOUNDARY) return;
    if (entry?.type === "custom" && entry.customType === CHECKPOINT_ENTRY && entry.data?.version === 1 && typeof entry.id === "string") {
      // An explicit rollover freezes the checkpoint while the response settles.
      // The pending-rollover tool gate prevents additional work in that interval.
      return !workAfter || entry.id === accepted && !newWork ? entry.id : undefined;
    }
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "toolResult" && CHECKPOINT_TOOLS.has(message.toolName)) continue;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      const calls = message.content.filter((part: any) => part.type === "toolCall");
      if (calls.length && calls.every((part: any) => CHECKPOINT_TOOLS.has(part.name))) continue;
      if (calls.length) newWork = true;
    }
    if (["user", "toolResult"].includes(message?.role)) newWork = true;
    if (["user", "assistant", "toolResult"].includes(message?.role)) workAfter = true;
  }
}
