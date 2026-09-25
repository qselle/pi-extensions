import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { lock } from "proper-lockfile";

export const ORIGINAL_IMAGE = "piOriginalImage";
export const MAX_ORIGINAL_BYTES = 32 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 32 * 1024;
export const MIN_ORIGINAL_BYTES = 64 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_CACHE_BYTES = 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface ImagePart { type: "image"; data: string; mimeType: string; [ORIGINAL_IMAGE]?: OriginalReference }
export interface OriginalReference {
  version: 1;
  hash: string;
  mimeType: string;
  bytes: number;
  previewHash: string;
  previewMimeType: string;
  signature: string;
}
type Preview = { data: string; mimeType: string };
export interface StorageOptions {
  resize?: (bytes: Uint8Array, mimeType: string) => Promise<Preview | null>;
  cacheBytes?: number;
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const isImagePart = (value: unknown): value is ImagePart => !!value && typeof value === "object"
  && (value as ImagePart).type === "image" && typeof (value as ImagePart).data === "string" && typeof (value as ImagePart).mimeType === "string";

/** Both original messages and canonical content edits can own image sources. */
export function entryContent(entry: any): unknown[] | undefined {
  const content = entry?.type === "message" ? entry.message?.content
    : entry?.type === "context_edit" ? entry.replacement?.content : undefined;
  return Array.isArray(content) ? content : undefined;
}

function decodeData(data: string, limit: number): Buffer | undefined {
  if (!data || data.length > Math.ceil(limit / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return;
  const bytes = Buffer.from(data, "base64");
  return bytes.length <= limit && bytes.toString("base64").replace(/=+$/, "") === data.replace(/=+$/, "") ? bytes : undefined;
}

export function originalReference(part: ImagePart): OriginalReference | undefined {
  const value = part[ORIGINAL_IMAGE];
  if (!value || value.version !== 1 || !DIGEST.test(value.hash) || !DIGEST.test(value.previewHash) || !DIGEST.test(value.signature)
    || !MIME.has(value.mimeType) || value.previewMimeType !== part.mimeType || !MIME.has(value.previewMimeType)
    || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_ORIGINAL_BYTES) return;
  return { version: 1, hash: value.hash, mimeType: value.mimeType, bytes: value.bytes,
    previewHash: value.previewHash, previewMimeType: value.previewMimeType, signature: value.signature };
}

function signingText(ref: Omit<OriginalReference, "signature">): string {
  return JSON.stringify([ref.version, ref.hash, ref.mimeType, ref.bytes, ref.previewHash, ref.previewMimeType]);
}

/** Private immutable originals; native image parts keep a small real preview. */
export class ImageStore {
  private initialization: Promise<Buffer> | undefined;
  private readonly cache = new Map<string, { image: ImagePart; bytes: number }>();
  private cacheSize = 0;
  private readonly previews = new Map<string, Preview>();
  private previewCacheSize = 0;
  private readonly cacheLimit: number;
  private readonly thumbnail: NonNullable<StorageOptions["resize"]>;
  readonly blobsDirectory: string;

  constructor(readonly directory: string, options: StorageOptions = {}) {
    this.blobsDirectory = join(directory, "originals");
    this.cacheLimit = Math.max(0, Math.min(MAX_CACHE_BYTES, options.cacheBytes ?? MAX_CACHE_BYTES));
    this.thumbnail = options.resize ?? ((bytes, mimeType) => resizeImage(bytes, mimeType, { maxWidth: 384, maxHeight: 384, maxBytes: MAX_PREVIEW_BYTES }));
  }

  private key(): Promise<Buffer> {
    this.initialization ??= this.initialize().catch((error) => { this.initialization = undefined; throw error; });
    return this.initialization;
  }

  private async initialize(): Promise<Buffer> {
    if (!process.getuid) throw new Error("Image storage requires POSIX file ownership.");
    for (const directory of [this.directory, this.blobsDirectory]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error("Image storage must be a private owned directory.");
      await chmod(directory, 0o700);
    }
    const path = join(this.directory, "reference-key");
    try { await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if ((await readdir(this.blobsDirectory)).some((name) => /^[a-f0-9]{64}\.blob$/.test(name))) {
        throw new Error("Image storage reference key is missing. Restore it before using the original store.");
      }
    }
    await this.createImmutable(path, randomBytes(32));
    const key = await this.readPrivate(path, 32);
    if (key.length !== 32) throw new Error("Image storage reference key is invalid.");
    return key;
  }

  private async createImmutable(path: string, bytes: Uint8Array): Promise<void> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.mode & 0o077) throw new Error("Image storage file is not private.");
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
      try {
        await link(temporary, path);
        const directory = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
  }

  private async readPrivate(path: string, limit: number, touch = false): Promise<Buffer> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size > limit) throw new Error("Image storage file is not private or exceeds its size limit.");
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== stat.size) throw new Error("Image storage file changed while reading.");
      if (touch) { const now = new Date(); await handle.utimes(now, now); }
      return buffer.subarray(0, offset);
    } finally { await handle.close(); }
  }

  /** Errors leave the caller's original intact; callers choose how to report them. */
  async pack(part: ImagePart): Promise<ImagePart> {
    if (!MIME.has(part.mimeType)) return part;
    const existing = originalReference(part);
    if (existing && await this.verifyReference(part, existing)) return part;
    const original = decodeData(part.data, MAX_ORIGINAL_BYTES);
    if (!original || original.length < MIN_ORIGINAL_BYTES) return part;
    const hash = digest(original), previewKey = `${hash}:${part.mimeType}`;
    const preview = this.previews.get(previewKey) ?? await this.thumbnail(original, part.mimeType);
    if (!preview || !MIME.has(preview.mimeType)) return part;
    const previewBytes = decodeData(preview.data, MAX_PREVIEW_BYTES);
    if (!previewBytes || previewBytes.length + 1024 >= original.length / 2) return part;
    const key = await this.key();
    const ref = { version: 1 as const, hash, mimeType: part.mimeType, bytes: original.length,
      previewHash: digest(previewBytes), previewMimeType: preview.mimeType };
    const path = this.originalPath(ref.hash);
    await this.withMaintenance(async (check) => {
      check();
      await this.createImmutable(path, original);
      const saved = await this.readPrivate(path, MAX_ORIGINAL_BYTES, true);
      if (saved.length !== original.length || digest(saved) !== ref.hash) throw new Error("Existing original image is corrupt.");
      check();
    });
    const previousPreview = this.previews.get(previewKey);
    if (previousPreview) { this.previews.delete(previewKey); this.previewCacheSize -= Buffer.byteLength(previousPreview.data); }
    const previewWeight = Buffer.byteLength(preview.data);
    while (this.previewCacheSize + previewWeight > MAX_PREVIEW_CACHE_BYTES) {
      const oldest = this.previews.keys().next().value!;
      this.previewCacheSize -= Buffer.byteLength(this.previews.get(oldest)!.data); this.previews.delete(oldest);
    }
    this.previews.set(previewKey, preview); this.previewCacheSize += previewWeight;
    const signature = createHmac("sha256", key).update(signingText(ref)).digest("hex");
    return { type: "image", data: preview.data, mimeType: preview.mimeType, [ORIGINAL_IMAGE]: { ...ref, signature } };
  }

  private originalPath(hash: string): string {
    if (!DIGEST.test(hash)) throw new Error("Invalid image hash.");
    return join(this.blobsDirectory, `${hash}.blob`);
  }

  private async verifyReference(part: ImagePart, ref: OriginalReference): Promise<boolean> {
    const preview = decodeData(part.data, MAX_PREVIEW_BYTES);
    if (!preview || digest(preview) !== ref.previewHash) return false;
    const signature = createHmac("sha256", await this.key()).update(signingText(ref)).digest();
    return timingSafeEqual(signature, Buffer.from(ref.signature, "hex"));
  }

  /** Resolve only after the caller has established ownership on the active branch. */
  async unpack(part: ImagePart): Promise<ImagePart> {
    const ref = originalReference(part);
    if (!ref || !await this.verifyReference(part, ref)) throw new Error("Original image reference cannot be verified.");
    const cacheKey = `${ref.hash}:${ref.mimeType}:${ref.bytes}`;
    const cached = this.cache.get(cacheKey);
    if (cached) { this.cache.delete(cacheKey); this.cache.set(cacheKey, cached); return { ...cached.image }; }
    const bytes = await this.readPrivate(this.originalPath(ref.hash), MAX_ORIGINAL_BYTES);
    if (bytes.length !== ref.bytes || digest(bytes) !== ref.hash) throw new Error("Original image is missing or corrupt.");
    const image: ImagePart = { type: "image", data: bytes.toString("base64"), mimeType: ref.mimeType };
    const weight = Buffer.byteLength(image.data);
    if (weight <= this.cacheLimit) {
      while (this.cacheSize + weight > this.cacheLimit) {
        const oldest = this.cache.keys().next().value!;
        this.cacheSize -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
      }
      this.cache.set(cacheKey, { image, bytes: weight }); this.cacheSize += weight;
    }
    return { ...image };
  }

  clearCache(): void { this.cache.clear(); this.cacheSize = 0; this.previews.clear(); this.previewCacheSize = 0; }
  cachedBytes(): number { return this.cacheSize; }

  /** Share the existing lease implementation with writers and explicit cleanup. */
  async withMaintenance<T>(run: (check: () => void) => Promise<T>): Promise<T> {
    await this.key();
    let compromised: Error | undefined;
    const release = await lock(this.directory, {
      lockfilePath: join(this.directory, ".maintenance.lock"), stale: 60_000, update: 10_000,
      retries: { retries: 4, minTimeout: 25, maxTimeout: 100 },
      onCompromised: (error) => { compromised = error; },
    });
    try { return await run(() => { if (compromised) throw compromised; }); }
    finally { await release(); }
  }

  /** Remember custom session roots before producing their first stored reference. */
  async rememberSessionDirectory(path: string): Promise<void> {
    await this.rememberPath("session-roots", path);
  }

  async rememberSessionFile(path: string): Promise<void> {
    await this.rememberSessionDirectory(dirname(resolve(path)));
    await this.rememberPath("session-files", path);
  }

  private async rememberPath(kind: "session-roots" | "session-files", path: string): Promise<void> {
    await this.key();
    const directory = join(this.directory, kind);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.mode & 0o077) throw new Error("Session root registry must be private.");
    const bytes = Buffer.from(resolve(path));
    if (bytes.length > 16 * 1024) throw new Error("Session directory path is too long.");
    await this.createImmutable(join(directory, `${digest(bytes)}.path`), bytes);
  }

  async sessionDirectories(): Promise<string[]> {
    return this.registeredPaths("session-roots");
  }

  async sessionFiles(): Promise<string[]> {
    return this.registeredPaths("session-files");
  }

  private async registeredPaths(kind: "session-roots" | "session-files"): Promise<string[]> {
    await this.key();
    const directory = join(this.directory, kind);
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const paths: string[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.path$/.test(name)) continue;
      const bytes = await this.readPrivate(join(directory, name), 16 * 1024);
      const path = bytes.toString("utf8");
      if (!isAbsolute(path) || digest(bytes) !== name.slice(0, -5)) throw new Error("Session root registry is invalid.");
      paths.push(path);
    }
    return paths;
  }
}
