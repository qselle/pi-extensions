import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageStore, ORIGINAL_IMAGE, originalReference, type ImagePart } from "./storage.ts";

const image = (byte: number): ImagePart => ({ type: "image", data: Buffer.alloc(80 * 1024, byte).toString("base64"), mimeType: "image/png" });
// Pixel encoding is separately covered by the native resize/persistence spike.
const resize = async () => ({ data: Buffer.alloc(20, 1).toString("base64"), mimeType: "image/png" });

test("stores duplicate originals once and round-trips signed previews across instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-images-store-"));
  try {
    const store = new ImageStore(root, { resize });
    const original = image(42);
    const [first, second] = await Promise.all([store.pack(original), store.pack(original)]);
    expect(first).toEqual(second);
    expect(first.data.length).toBeLessThan(original.data.length / 100);
    expect(original[ORIGINAL_IMAGE]).toBeUndefined();
    expect(await readdir(store.blobsDirectory)).toHaveLength(1);
    expect(await new ImageStore(root).unpack(first)).toEqual(original);
    expect(await store.pack(first)).toBe(first);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects forged references, substituted previews, unsafe files and corrupt originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-images-integrity-"));
  try {
    const store = new ImageStore(root, { resize, cacheBytes: 0 });
    const part = await store.pack(image(3));
    const ref = originalReference(part)!;
    await expect(store.unpack({ ...part, [ORIGINAL_IMAGE]: { ...ref, hash: "f".repeat(64) } })).rejects.toThrow("verified");
    await expect(store.unpack({ ...part, data: Buffer.alloc(20, 2).toString("base64") })).rejects.toThrow("verified");
    const path = join(store.blobsDirectory, `${ref.hash}.blob`);
    await writeFile(path, "corrupt");
    await expect(store.unpack(part)).rejects.toThrow("corrupt");
    await expect(store.pack(image(3))).rejects.toThrow("corrupt");
    await unlink(path);
    const other = join(root, "other"); await writeFile(other, Buffer.alloc(80 * 1024, 3), { mode: 0o600 });
    await symlink(other, path);
    await expect(store.unpack(part)).rejects.toThrow();
    expect(originalReference({ ...part, [ORIGINAL_IMAGE]: { ...ref, hash: "../../outside" } })).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("small or unresizable images stay embedded and original cache is byte bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-images-cache-"));
  try {
    const store = new ImageStore(root, { resize, cacheBytes: 120 * 1024 });
    const small = { ...image(1), data: "aGVsbG8=" };
    expect(await store.pack(small)).toBe(small);
    const unresizable = new ImageStore(join(root, "none"), { resize: async () => null });
    const original = image(1); expect(await unresizable.pack(original)).toBe(original);
    const a = await store.pack(original), b = await store.pack(image(2));
    expect(await store.unpack(a)).toEqual(original);
    expect(store.cachedBytes()).toBeGreaterThan(0);
    expect(await store.unpack(b)).toEqual(image(2));
    expect(store.cachedBytes()).toBeLessThanOrEqual(120 * 1024);
    store.clearCache(); expect(store.cachedBytes()).toBe(0);
    await expect(new ImageStore(join(root, "another")).unpack(a)).rejects.toThrow("verified");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a lost signing key never creates a replacement over committed originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-images-key-"));
  try {
    let resizes = 0;
    const store = new ImageStore(root, { resize: async () => { resizes++; return resize(); } });
    const part = await store.pack(image(4));
    await store.pack(image(4));
    expect(resizes).toBe(1);
    store.clearCache(); await store.pack(image(4));
    expect(resizes).toBe(2);
    await unlink(join(root, "reference-key"));
    const reopened = new ImageStore(root, { resize });
    await expect(reopened.unpack(part)).rejects.toThrow("key is missing");
    await expect(reopened.pack(image(5))).rejects.toThrow("key is missing");
    expect(await readdir(root)).not.toContain("reference-key");
    expect(await readdir(store.blobsDirectory)).toHaveLength(1);
    const unavailable = join(root, "file-instead-of-directory");
    await writeFile(unavailable, "occupied");
    await expect(new ImageStore(unavailable, { resize }).pack(image(6))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
