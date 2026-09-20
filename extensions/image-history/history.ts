export const STATE_TYPE = "image-history-state";
interface Image { type: "image"; data: string; mimeType: string }
const isImage = (part: any): part is Image => part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string";
export function restoreEnabled(entries: readonly any[]): boolean {
  let enabled = false;
  for (const entry of entries) if (entry.type === "custom" && entry.customType === STATE_TYPE && entry.data?.version === 1 && typeof entry.data.enabled === "boolean") enabled = entry.data.enabled;
  return enabled;
}
export function retrieveImage(entries: readonly any[], reference: string): Image | undefined {
  const separator = reference.lastIndexOf(":");
  const id = reference.slice(0, separator);
  const index = reference.slice(separator + 1);
  if (separator < 1 || !/^\d+$/.test(index)) return;
  const entry = entries.find((candidate) => candidate.id === id && candidate.type === "message");
  const part = Array.isArray(entry?.message?.content) ? entry.message.content[Number(index)] : undefined;
  return isImage(part) ? { type: "image", data: part.data, mimeType: part.mimeType } : undefined;
}

/** Rewrite only recoverable images before the latest user turn, never history. */
export function referenceOlderImages<T>(messages: readonly T[], entries: readonly any[]): { messages: T[]; replaced: number } {
  const references = new Map<string, Map<string, string>>();
  for (const entry of entries) {
    if (entry.type !== "message" || typeof entry.id !== "string" || !Array.isArray(entry.message?.content)) continue;
    entry.message.content.forEach((part: any, index: number) => {
      if (!isImage(part)) return;
      let byData = references.get(part.mimeType);
      if (!byData) references.set(part.mimeType, byData = new Map());
      if (!byData.has(part.data)) byData.set(part.data, `${entry.id}:${index}`);
    });
  }
  let latestUser = -1;
  messages.forEach((message: any, index) => { if (message.role === "user") latestUser = index; });
  let replaced = 0;
  const output = messages.map((raw, index) => {
    const message = raw as any;
    if (index >= latestUser || !Array.isArray(message.content) || !["user", "toolResult"].includes(message.role)) return raw;
    let changed = false;
    const content = message.content.map((part: any) => {
      if (!isImage(part)) return part;
      const reference = references.get(part.mimeType)?.get(part.data);
      if (!reference) return part;
      changed = true;
      replaced++;
      return { type: "text", text: `[Earlier image (${part.mimeType}); use history_image with reference "${reference}" to inspect it again.]` };
    });
    return changed ? { ...message, content } : raw;
  });
  return { messages: output, replaced };
}
