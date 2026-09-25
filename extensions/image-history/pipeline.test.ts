import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageStore, ORIGINAL_IMAGE, originalReference, type ImagePart } from "./storage.ts";
import { exportPortableSession, hydrateImages, storeMessage } from "./pipeline.ts";
import { referenceOlderImages, retrieveImage } from "./history.ts";

const original: ImagePart = { type: "image", data: Buffer.alloc(80 * 1024, 6).toString("base64"), mimeType: "image/png" };
const resize = async () => ({ data: Buffer.alloc(20, 2).toString("base64"), mimeType: "image/png" });

test("defers before hydration, resolves only current branch images, and labels missing originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-image-pipeline-"));
  try {
    const store = new ImageStore(root, { resize, cacheBytes: 0 });
    const old = await storeMessage({ role: "user", content: [original], timestamp: 1 }, store);
    const current = { ...old, timestamp: 2 };
    const entries = [{ type: "message", id: "old", message: old }, { type: "message", id: "current", message: current }];
    const deferred = referenceOlderImages([old, current], entries);
    expect(deferred.replaced).toBe(1);
    const hydrated = await hydrateImages(deferred.messages, entries, store);
    expect(JSON.stringify(hydrated[0])).toContain("old:0");
    expect(hydrated[1].content).toEqual([original]);
    expect(JSON.stringify(hydrated)).not.toContain(ORIGINAL_IMAGE);
    expect(await hydrateImages([], entries, store)).toEqual([]);
    const foreign = await hydrateImages([current], [], store);
    expect(foreign[0].content[0]).not.toEqual(original);
    expect(JSON.stringify(foreign)).toContain("Original image unavailable");
    expect(old.content[0][ORIGINAL_IMAGE]).toBeDefined();
    await unlink(join(store.blobsDirectory, `${originalReference(old.content[0])!.hash}.blob`));
    const missing = await hydrateImages([current], entries, store);
    expect(JSON.stringify(missing)).toContain("Fine detail and original coordinates cannot be verified");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("storage failure retains original bytes; portable export embeds originals without rewriting source or overwriting files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-image-export-"));
  try {
    const store = new ImageStore(join(root, "store"), { resize, cacheBytes: 0 });
    const message = { role: "user", content: [original], timestamp: 1 };
    let failures = 0;
    const failing = new ImageStore(join(root, "failing"), { resize: async () => { throw new Error("resize failed"); } });
    expect(await storeMessage(message, failing, () => failures++)).toBe(message);
    expect(failures).toBe(1);
    const stored = await storeMessage(message, store);
    const entries = [{ type: "message", id: "entry", parentId: null, message: stored }];
    const before = JSON.stringify(entries);
    const header = { type: "session", version: 3, id: "test", timestamp: "2026-09-25T00:00:00.000Z", cwd: root };
    const destination = join(root, "portable.jsonl");
    const result = await exportPortableSession(header, entries, destination, store);
    const text = await readFile(destination, "utf8");
    expect(result.images).toBe(1);
    expect(text).not.toContain(ORIGINAL_IMAGE);
    expect(text).toContain(original.data);
    expect(JSON.parse(text.trim().split("\n")[1]!).id).toBe("entry");
    expect(JSON.stringify(entries)).toBe(before);
    await expect(exportPortableSession(header, entries, destination, store)).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe(text);
    await unlink(join(store.blobsDirectory, `${originalReference(stored.content[0])!.hash}.blob`));
    const missing = join(root, "missing.jsonl");
    await expect(exportPortableSession(header, entries, missing, store)).rejects.toThrow();
    expect((await readdir(root)).some((name) => name.startsWith("missing.jsonl"))).toBe(false);
    const abort = AbortSignal.abort();
    await expect(exportPortableSession(header, entries, join(root, "cancelled.jsonl"), store, abort)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identical previews keep distinct original identities, including images introduced by context edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-image-identities-"));
  try {
    const store = new ImageStore(root, { resize });
    const secondOriginal = { ...original, data: Buffer.alloc(80 * 1024, 9).toString("base64") };
    const a = await store.pack(original), b = await store.pack(secondOriginal);
    expect(a.data).toBe(b.data);
    const first = { role: "user", content: [a] }, second = { role: "toolResult", content: [b] };
    const entries = [
      { type: "message", id: "first", message: first },
      { type: "context_edit", id: "edit", targetId: "second", replacement: { content: [b] } },
    ];
    const result = referenceOlderImages([first, second, { role: "user", content: [] }], entries);
    expect(JSON.stringify(result.messages[0])).toContain("first:0");
    expect(JSON.stringify(result.messages[1])).toContain("edit:0");
    expect(await store.unpack(retrieveImage(entries, "edit:0")!)).toEqual(secondOriginal);
    expect((await hydrateImages([second], entries, store))[0]!.content).toEqual([secondOriginal]);
    const destination = join(root, "portable.jsonl");
    const exported = await exportPortableSession({ type: "session" }, entries, destination, store);
    expect(exported.images).toBe(2);
    const text = await readFile(destination, "utf8");
    expect(text).not.toContain(ORIGINAL_IMAGE);
    expect(JSON.parse(text.trim().split("\n")[2]!).replacement.content).toEqual([secondOriginal]);
    expect(entries[1]!.replacement!.content[0]).toBe(b);
  } finally { await rm(root, { recursive: true, force: true }); }
});
