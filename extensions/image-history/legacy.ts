import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { getCapabilities, Image, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { isImagePart, type ImagePart } from "./storage.ts";

/**
 * Sessions written by the earlier sidecar image store keep content-addressed
 * references in message details and a text placeholder in tool results. Blobs
 * live at `<agent dir>/image-store/sha256/<2 hex>/<sha256>.<ext>`.
 */
export const LEGACY_DETAILS = "__pi_image_store";
export const LEGACY_PLACEHOLDER = "[image stored externally]";
export const LEGACY_PREVIEW_ENTRY = "image-store-v1";
export const MAX_LEGACY_BYTES = 32 * 1024 * 1024;
/** Transcript restoration keeps at most this many decoded bytes in session memory. */
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_REFERENCES = 64;
const CACHE_BYTES = 16 * 1024 * 1024;
const EXTENSIONS = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/gif", "gif"], ["image/webp", "webp"]]);

export interface LegacyReference { digest: string; mimeType: string; bytes: number }

export function legacyReference(value: unknown): LegacyReference | undefined {
  const ref = value as Partial<LegacyReference> | null;
  if (!ref || typeof ref !== "object" || typeof ref.digest !== "string" || !/^[0-9a-f]{64}$/.test(ref.digest)
    || typeof ref.mimeType !== "string" || !EXTENSIONS.has(ref.mimeType)
    || !Number.isSafeInteger(ref.bytes) || ref.bytes! <= 0 || ref.bytes! > MAX_LEGACY_BYTES) return;
  return { digest: ref.digest, mimeType: ref.mimeType, bytes: ref.bytes! };
}

/** Positional references; an invalid slot stays undefined so later placeholders keep their order. */
export function legacyReferences(message: unknown): (LegacyReference | undefined)[] {
  const details = (message as { details?: Record<string, any> } | null)?.details?.[LEGACY_DETAILS];
  if (details?.version !== 1 || !Array.isArray(details.refs)) return [];
  return details.refs.slice(0, MAX_REFERENCES).map(legacyReference);
}

const owned = (stat: Stats) => !process.getuid || stat.uid === process.getuid();

/** Verified, symlink-free reads with a byte-bounded cache. Synchronous so renderers can use it. */
export class LegacyImageStore {
  readonly root: string;
  private readonly cache = new Map<string, string>();
  private cacheSize = 0;

  constructor(agentDirectory: string, private readonly cacheLimit = CACHE_BYTES) {
    this.root = join(agentDirectory, "image-store", "sha256");
  }

  load(ref: LegacyReference): ImagePart {
    const key = `${ref.digest}:${ref.mimeType}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key); this.cache.set(key, cached);
      return { type: "image", data: cached, mimeType: ref.mimeType };
    }
    const directory = join(this.root, ref.digest.slice(0, 2));
    for (const path of [dirname(this.root), this.root, directory]) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) throw new Error("Stored image directory is unsafe.");
    }
    const path = join(directory, `${ref.digest}.${EXTENSIONS.get(ref.mimeType)}`);
    if (lstatSync(path).isSymbolicLink()) throw new Error("Stored image is a symlink.");
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let data: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || !owned(stat) || stat.size !== ref.bytes) throw new Error("Stored image is unsafe or has the wrong size.");
      const buffer = Buffer.alloc(ref.bytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (!read) break;
        offset += read;
      }
      const bytes = buffer.subarray(0, offset);
      if (offset !== ref.bytes || createHash("sha256").update(bytes).digest("hex") !== ref.digest) {
        throw new Error("Stored image failed SHA-256 verification.");
      }
      data = bytes.toString("base64");
    } finally { closeSync(fd); }
    if (data.length <= this.cacheLimit) {
      while (this.cacheSize + data.length > this.cacheLimit) {
        const oldest = this.cache.keys().next().value!;
        this.cacheSize -= this.cache.get(oldest)!.length; this.cache.delete(oldest);
      }
      this.cache.set(key, data); this.cacheSize += data.length;
    }
    return { type: "image", data, mimeType: ref.mimeType };
  }

  clearCache(): void { this.cache.clear(); this.cacheSize = 0; }
}

const unavailable = (ref: LegacyReference | undefined) => ({ type: "text" as const,
  text: `[Stored image ${ref ? ref.digest.slice(0, 12) : "reference"} unavailable: its sidecar file is missing, unsafe, or failed SHA-256 verification.]` });

/**
 * Put each verified image back where its placeholder was; references without a
 * placeholder (attached-image messages) are appended. Free text is never parsed
 * for references. Returns the same message when nothing needs restoring.
 */
export function restoreLegacyMessage<T>(message: T, store: LegacyImageStore, onFailure: () => void = () => {}): T {
  const value = message as any;
  if (value?.role !== "toolResult" && value?.role !== "custom") return message;
  const refs = legacyReferences(value);
  if (!refs.length) return message;
  const content: any[] | undefined = typeof value.content === "string" ? [{ type: "text", text: value.content }]
    : Array.isArray(value.content) ? [...value.content] : undefined;
  if (!content) return message;
  const slots = content.flatMap((part, index) => part?.type === "text" && part.text === LEGACY_PLACEHOLDER ? [index] : []);
  // A fork or export of an already restored transcript embeds the images.
  if (!slots.length && content.filter(isImagePart).length >= refs.length) return message;
  const restored = refs.map((ref) => {
    try { if (ref) return store.load(ref); } catch {}
    onFailure();
    return unavailable(ref);
  });
  slots.forEach((slot, index) => { if (index < restored.length) content[slot] = restored[index]; });
  content.push(...restored.slice(slots.length));
  return { ...value, content };
}

export function restoreLegacyMessages<T>(messages: readonly T[], store: LegacyImageStore, onFailure?: () => void): T[] {
  return messages.map((message) => restoreLegacyMessage(message, store, onFailure));
}

/**
 * Pi renders tool results from the loaded entry objects, so restored content is
 * placed on those in-memory messages. The session file is never written.
 * Newest results are restored first within a total byte budget.
 */
export function restoreLegacyTranscript(entries: readonly any[], store: LegacyImageStore, onFailure?: () => void,
  budget = MAX_TRANSCRIPT_BYTES): number {
  let restored = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index]?.type === "message" ? entries[index].message : undefined;
    if (message?.role !== "toolResult") continue;
    const refs = legacyReferences(message);
    if (!refs.length) continue;
    budget -= refs.reduce((sum, ref) => sum + (ref?.bytes ?? 0), 0);
    if (budget < 0) break;
    const next = restoreLegacyMessage(message, store, onFailure);
    if (next !== message) { message.content = next.content; restored++; }
  }
  return restored;
}

/** Transcript row for an attached-image entry written by the earlier store. */
export class LegacyImagePreview implements Component {
  private readonly image: Image | undefined;
  private readonly label: string;

  constructor(ref: LegacyReference, label: string | undefined, store: LegacyImageStore, private readonly theme: Theme) {
    let image: ImagePart | undefined;
    try { image = store.load(ref); } catch {}
    const capabilities = getCapabilities().images;
    const clean = label?.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    this.label = `${clean ? `${clean} · ` : ""}${ref.digest.slice(0, 8)} · ${Math.ceil(ref.bytes / 1024)} KB${image ? "" : " · unavailable"}`;
    if (image && (capabilities !== "kitty" || image.mimeType === "image/png")) {
      this.image = new Image(image.data, image.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }, { maxWidthCells: 60 });
    }
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    return [truncateToWidth(this.theme.fg("dim", `↳ image ${this.label}`), width), ...(this.image?.render(width) ?? [])];
  }

  invalidate(): void { this.image?.invalidate(); }
}
