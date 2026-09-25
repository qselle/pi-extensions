import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { ImageStore, ORIGINAL_IMAGE, entryContent, isImagePart, originalReference, type ImagePart } from "./storage.ts";

export const STORAGE_STATE_TYPE = "image-store-state";
export function restoreStorageEnabled(entries: readonly any[]): boolean {
  let enabled = false;
  for (const entry of entries) if (entry?.type === "custom" && entry.customType === STORAGE_STATE_TYPE
    && entry.data?.version === 1 && typeof entry.data.enabled === "boolean") enabled = entry.data.enabled;
  return enabled;
}

export interface StoredImageLocation { reference: string; image: ImagePart }
export function storedImages(entries: readonly any[]): StoredImageLocation[] {
  return entries.flatMap((entry) => typeof entry?.id !== "string" ? []
    : (entryContent(entry) ?? []).flatMap((part: unknown, index: number) => isImagePart(part) && originalReference(part)
      ? [{ reference: `${entry.id}:${index}`, image: part }] : []));
}

/** Compress finalized image parts only after each original has been committed. */
export async function storeMessage<T>(message: T, store: ImageStore, onFailure: () => void = () => {}): Promise<T> {
  const value = message as any;
  if (!["user", "toolResult"].includes(value?.role) || !Array.isArray(value.content)) return message;
  let changed = false;
  const content = [];
  for (const part of value.content) {
    if (!isImagePart(part)) { content.push(part); continue; }
    try {
      const stored = await store.pack(part);
      changed ||= stored !== part;
      content.push(stored);
    } catch { onFailure(); content.push(part); }
  }
  return changed ? { ...value, content } : message;
}

const cleanImage = (part: ImagePart): ImagePart => ({ type: "image", data: part.data, mimeType: part.mimeType });

/** Deferral runs first; this resolves only images still present in provider context. */
export async function hydrateImages<T>(messages: readonly T[], entries: readonly any[], store: ImageStore,
  onFailure: () => void = () => {}): Promise<T[]> {
  // Signed references bind the preview bytes and original; indexing signatures
  // keeps a long image history linear instead of rescanning it for every image.
  const owned = new Set(storedImages(entries).map(({ image }) => originalReference(image)!.signature));
  const output: T[] = [];
  for (const raw of messages) {
    const message = raw as any;
    if (!Array.isArray(message?.content) || !["user", "toolResult"].includes(message.role)) { output.push(raw); continue; }
    let changed = false;
    const content = [];
    for (const part of message.content) {
      if (!isImagePart(part) || part[ORIGINAL_IMAGE] === undefined) { content.push(part); continue; }
      changed = true;
      try {
        const reference = originalReference(part);
        if (!reference || !owned.has(reference.signature)) throw new Error("Image reference is not owned by this branch.");
        content.push(await store.unpack(part));
      } catch {
        onFailure();
        content.push(cleanImage(part), { type: "text", text: "[Original image unavailable: only the embedded preview is shown. Fine detail and original coordinates cannot be verified from this preview.]" });
      }
    }
    output.push(changed ? { ...message, content } : raw);
  }
  return output;
}

/** Export a complete graph with originals embedded, never rewriting the live file. */
export async function exportPortableSession(header: unknown, entries: readonly any[], destination: string, store: ImageStore,
  signal?: AbortSignal): Promise<{ images: number; bytes: number }> {
  if (!header || typeof header !== "object") throw new Error("A saved session header is required for portable export.");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let images = 0, bytes = 0;
  const write = async (entry: unknown) => {
    signal?.throwIfAborted();
    const line = JSON.stringify(entry) + "\n";
    await handle!.writeFile(line); bytes += Buffer.byteLength(line);
  };
  try {
    signal?.throwIfAborted();
    handle = await open(temporary, "wx", 0o600);
    await write(header);
    for (const entry of entries) {
      const source = entryContent(entry);
      if (!source) { await write(entry); continue; }
      const content = [];
      for (const part of source) {
        signal?.throwIfAborted();
        if (isImagePart(part) && part[ORIGINAL_IMAGE] !== undefined) { content.push(await store.unpack(part)); images++; }
        else content.push(part);
      }
      const field = entry.type === "context_edit" ? "replacement" : "message";
      await write({ ...entry, [field]: { ...entry[field], content } });
    }
    await handle.sync(); await handle.close(); handle = undefined;
    signal?.throwIfAborted();
    await link(temporary, destination);
    return { images, bytes };
  } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
}
