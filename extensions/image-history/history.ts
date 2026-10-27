import { entryContent, ORIGINAL_IMAGE, originalReference, type ImagePart as Image } from "./storage.ts";
export const STATE_TYPE = "image-history-state";
const isImage = (part: any): part is Image => part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string";
/** The latest branch entry wins; without one, the configured default applies. */
export function restoreEnabled(entries: readonly any[], fallback = false): boolean {
  let enabled = fallback;
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

/** Recoverable older images deferred together, so the rewritten prefix moves rarely. */
export const DEFERRAL_BATCH = 8;

/**
 * Rewrite only recoverable images before a user-turn boundary, never history.
 * The boundary advances to a user turn only once `batch` recoverable images
 * precede it. It depends only on earlier messages, so each request keeps the
 * previous request's prefix until a whole batch is deferred at once.
 */
export function referenceOlderImages<T>(messages: readonly T[], entries: readonly any[], batch = DEFERRAL_BATCH): { messages: T[]; replaced: number } {
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
  const referenceOf = (part: any) => {
    if (!isImage(part)) return undefined;
    const identity = imageIdentity(part);
    return identity ? references.get(part.mimeType)?.get(identity) : undefined;
  };
  const deferrable = (message: any) => Array.isArray(message?.content) && ["user", "toolResult"].includes(message.role);
  let boundary = 0;
  let pending = 0;
  messages.forEach((message: any, index) => {
    if (message?.role === "user" && pending >= batch) { boundary = index; pending = 0; }
    if (deferrable(message)) pending += message.content.filter(referenceOf).length;
  });
  let replaced = 0;
  const output = messages.map((raw, index) => {
    const message = raw as any;
    if (index >= boundary || !deferrable(message)) return raw;
    let changed = false;
    const content = message.content.map((part: any) => {
      const reference = referenceOf(part);
      if (!reference) return part;
      changed = true;
      replaced++;
      return { type: "text", text: `[Earlier image (${part.mimeType}); use history_image with reference "${reference}" to inspect it again.]` };
    });
    return changed ? { ...message, content } : raw;
  });
  return { messages: output, replaced };
}
