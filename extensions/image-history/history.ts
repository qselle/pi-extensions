import { entryContent, ORIGINAL_IMAGE, originalReference, type ImagePart as Image } from "./storage.ts";
export const STATE_TYPE = "image-history-state";
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
  const entry = entries.find((candidate) => candidate.id === id);
  const part = entryContent(entry)?.[Number(index)];
  return isImage(part) ? { type: "image", data: part.data, mimeType: part.mimeType,
    ...(part[ORIGINAL_IMAGE] === undefined ? {} : { [ORIGINAL_IMAGE]: part[ORIGINAL_IMAGE] }) } : undefined;
}

function imageIdentity(part: Image): string | undefined {
  if (part[ORIGINAL_IMAGE] === undefined) return `data:${part.data}`;
  const ref = originalReference(part);
  // Different originals can have identical downsampled previews. A signature
  // binds both original identity and preview; preview bytes alone are ambiguous.
  return ref ? `original:${ref.signature}` : undefined;
}

/** Rewrite only recoverable images before the latest user turn, never history. */
export function referenceOlderImages<T>(messages: readonly T[], entries: readonly any[]): { messages: T[]; replaced: number } {
  const references = new Map<string, Map<string, string>>();
  for (const entry of entries) {
    const content = entryContent(entry);
    if (typeof entry.id !== "string" || !content) continue;
    content.forEach((part: any, index: number) => {
      if (!isImage(part)) return;
      const identity = imageIdentity(part);
      if (!identity) return;
      let byData = references.get(part.mimeType);
      if (!byData) references.set(part.mimeType, byData = new Map());
      if (!byData.has(identity)) byData.set(identity, `${entry.id}:${index}`);
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
      const identity = imageIdentity(part);
      const reference = identity ? references.get(part.mimeType)?.get(identity) : undefined;
      if (!reference) return part;
      changed = true;
      replaced++;
      return { type: "text", text: `[Earlier image (${part.mimeType}); use history_image with reference "${reference}" to inspect it again.]` };
    });
    return changed ? { ...message, content } : raw;
  });
  return { messages: output, replaced };
}
