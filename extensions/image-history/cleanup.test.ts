import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageStore, originalReference, type ImagePart } from "./storage.ts";
import { inspectStorage, ORIGINAL_GRACE_MS, removeUnusedOriginals } from "./cleanup.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const image = (byte: number): ImagePart => ({ type: "image", data: Buffer.alloc(80 * 1024, byte).toString("base64"), mimeType: "image/png" });
const resize = async () => ({ data: Buffer.alloc(20, 1).toString("base64"), mimeType: "image/png" });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-image-cleanup-"));
  const store = new ImageStore(join(root, "store"), { resize });
  const sessions = join(root, "sessions");
  await mkdir(sessions); await store.rememberSessionDirectory(sessions);
  const a = await store.pack(image(1)), b = await store.pack(image(2));
  const paths = [a, b].map((part) => join(store.blobsDirectory, `${originalReference(part)!.hash}.blob`));
  const age = new Date(Date.now() - ORIGINAL_GRACE_MS * 2);
  for (const path of paths) await utimes(path, age, age);
  return { root, store, sessions, a, b, paths };
};

test("cleanup covers all saved branches and remembered custom session directories", async () => {
  const f = await fixture();
  try {
    const custom = join(f.root, "custom"); await mkdir(custom);
    await f.store.rememberSessionDirectory(custom);
    // References on an inactive branch and inside context edits both count.
    await writeFile(join(custom, "fork.jsonl"), JSON.stringify({ type: "context_edit", replacement: { content: [f.a] } }) + "\n");
    const snapshot = await inspectStorage(f.store, f.sessions);
    expect(snapshot.sessionFiles).toBe(1);
    expect(snapshot.originals).toHaveLength(2);
    expect(snapshot.candidates.map((part) => part.hash)).toEqual([originalReference(f.b)!.hash]);
    expect(await removeUnusedOriginals(f.store, f.sessions, snapshot.candidates)).toEqual({ files: 1, bytes: 80 * 1024 });
    expect((await readFile(f.paths[0]!)).length).toBe(80 * 1024);
    await expect(readFile(f.paths[1]!)).rejects.toThrow();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("cleanup rechecks references and original reuse after the confirmation preview", async () => {
  const f = await fixture();
  try {
    const snapshot = await inspectStorage(f.store, f.sessions);
    expect(snapshot.candidates).toHaveLength(2);
    await writeFile(join(f.sessions, "new.jsonl"), JSON.stringify({ content: [f.a] }) + "\n");
    await f.store.pack(image(2)); // Refreshes the 48-hour grace period under the shared writer lease.
    expect(await removeUnusedOriginals(f.store, f.sessions, snapshot.candidates)).toEqual({ files: 0, bytes: 0 });
    expect((await inspectStorage(f.store, f.sessions)).candidates).toHaveLength(0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("missing custom roots, malformed sessions, symlinks and cancellation stop cleanup without deleting", async () => {
  const f = await fixture();
  try {
    const snapshot = await inspectStorage(f.store, f.sessions);
    const path = join(f.sessions, "broken.jsonl");
    await writeFile(path, '{"content":');
    await expect(removeUnusedOriginals(f.store, f.sessions, snapshot.candidates)).rejects.toThrow();
    await unlink(path); await symlink(f.paths[0]!, path);
    await expect(inspectStorage(f.store, f.sessions)).rejects.toThrow("symlink");
    await unlink(path);
    await expect(removeUnusedOriginals(f.store, f.sessions, snapshot.candidates, AbortSignal.abort())).rejects.toThrow();
    await f.store.rememberSessionDirectory(join(f.root, "unmounted"));
    await expect(inspectStorage(f.store, f.sessions)).rejects.toThrow("Cannot inspect");
    for (const original of f.paths) expect((await readFile(original)).length).toBe(80 * 1024);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("cleanup finds native sessions with arbitrary filenames and protects registered damaged files", async () => {
  const f = await fixture();
  try {
    const path = join(f.sessions, "my-session.history");
    await writeFile(path, [
      { type: "session", version: 3, id: "renamed", timestamp: "2026-09-25T00:00:00.000Z", cwd: f.root },
      { type: "message", id: "source", parentId: null, timestamp: "2026-09-25T00:00:00.000Z", message: { role: "user", content: [f.a], timestamp: 1 } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const reopened = SessionManager.open(path);
    expect(reopened.getBranch()).toHaveLength(1);
    // An unregistered renamed copy is also inspected, with no extension filter.
    let inventory = await inspectStorage(f.store, f.sessions);
    expect(inventory.candidates.map((file) => file.hash)).toEqual([originalReference(f.b)!.hash]);
    await f.store.rememberSessionFile(path);
    await writeFile(join(f.sessions, ".DS_Store"), Buffer.from([0, 1, 2, 3]));
    inventory = await inspectStorage(f.store, f.sessions);
    expect(inventory.sessionFiles).toBe(1);
    await writeFile(path, '{"unfinished":');
    await expect(removeUnusedOriginals(f.store, f.sessions, inventory.candidates)).rejects.toThrow("Malformed");
    for (const damaged of ["", '{"unrelated":true}', '{"type":"session"}']) {
      await writeFile(path, damaged);
      await expect(removeUnusedOriginals(f.store, f.sessions, inventory.candidates)).rejects.toThrow("header");
    }
    await unlink(path);
    expect((await inspectStorage(f.store, f.sessions)).candidates).toHaveLength(2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
