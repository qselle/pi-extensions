import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCapabilities } from "@earendil-works/pi-tui";
import { inspectStorage, ORIGINAL_GRACE_MS, removeUnusedOriginals } from "./cleanup.ts";
import { ImageStore } from "./storage.ts";
import { legacyToolResult, writeLegacyBlob } from "./legacy.fixture.ts";
import {
  LEGACY_DETAILS, LEGACY_PLACEHOLDER, LegacyImagePreview, LegacyImageStore, MAX_LEGACY_BYTES,
  restoreLegacyMessage, restoreLegacyMessages, restoreLegacyTranscript,
} from "./legacy.ts";

const fixture = async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-legacy-images-"));
  const first = await writeLegacyBlob(agentDir, Buffer.from("first image bytes"));
  const second = await writeLegacyBlob(agentDir, Buffer.from("second image bytes"), "jpg");
  return { agentDir, first, second, store: new LegacyImageStore(agentDir) };
};

test("restores verified sidecar bytes in placeholder order without mutating the input", async () => {
  const f = await fixture();
  try {
    const message = legacyToolResult([f.first.ref, f.second.ref]);
    const before = JSON.stringify(message);
    const restored = restoreLegacyMessage(message, f.store);
    expect(restored.content).toEqual([
      message.content[0],
      { type: "image", data: Buffer.from("first image bytes").toString("base64"), mimeType: "image/png" },
      { type: "image", data: Buffer.from("second image bytes").toString("base64"), mimeType: "image/jpeg" },
    ]);
    expect(JSON.stringify(message)).toBe(before);
    expect(restoreLegacyMessage(restored, f.store)).toBe(restored);
    // Attached-image messages carry references without a placeholder.
    const attached = { role: "custom", customType: "image-store-context-v1", content: "Attached image sidecar.", display: false,
      details: { [LEGACY_DETAILS]: { version: 1, refs: [f.first.ref] } } };
    expect((restoreLegacyMessage(attached, f.store) as any).content).toEqual([
      { type: "text", text: "Attached image sidecar." },
      { type: "image", data: Buffer.from("first image bytes").toString("base64"), mimeType: "image/png" },
    ]);
  } finally { await rm(f.agentDir, { recursive: true, force: true }); }
});

test("free-text references, other roles and malformed details never load files", async () => {
  const f = await fixture();
  try {
    const marker = `[image ${f.first.digest.slice(0, 8)}](pi-image://sha256/${f.first.digest}?mime=image%2Fpng&bytes=17)`;
    const messages = [
      { role: "user", content: [{ type: "text", text: marker }], details: { [LEGACY_DETAILS]: { version: 1, refs: [f.first.ref] } } },
      { role: "toolResult", content: [{ type: "text", text: marker }] },
      { ...legacyToolResult([f.first.ref]), details: { [LEGACY_DETAILS]: { version: 2, refs: [f.first.ref] } } },
    ];
    const restored = restoreLegacyMessages(messages, f.store);
    restored.forEach((message, index) => expect(message).toBe(messages[index]!));
  } finally { await rm(f.agentDir, { recursive: true, force: true }); }
});

test("corrupt, resized, symlinked and oversized sidecars become explicit notes", async () => {
  const f = await fixture();
  try {
    let failures = 0;
    const onFailure = () => failures++;
    const note = (message: any, slot = 1) => message.content[slot].text as string;
    // Hash mismatch with the expected size.
    await writeFile(f.first.path, Buffer.from("first image bytez"));
    expect(note(restoreLegacyMessage(legacyToolResult([f.first.ref]), new LegacyImageStore(f.agentDir), onFailure)))
      .toContain(`Stored image ${f.first.digest.slice(0, 12)} unavailable`);
    // Size disagreement with the reference.
    expect(note(restoreLegacyMessage(legacyToolResult([{ ...f.second.ref, bytes: 3 }]), f.store, onFailure))).toContain("unavailable");
    // Oversized or unsupported references are rejected before any read.
    expect(note(restoreLegacyMessage(legacyToolResult([{ ...f.second.ref, bytes: MAX_LEGACY_BYTES + 1 }]), f.store, onFailure))).toContain("unavailable");
    expect(note(restoreLegacyMessage(legacyToolResult([{ ...f.second.ref, mimeType: "image/svg+xml" }]), f.store, onFailure))).toContain("unavailable");
    // A symlinked blob, even to the right bytes.
    const outside = join(f.agentDir, "outside.jpg");
    await rename(f.second.path, outside);
    await symlink(outside, f.second.path);
    expect(note(restoreLegacyMessage(legacyToolResult([f.second.ref]), new LegacyImageStore(f.agentDir), onFailure))).toContain("unavailable");
    // A symlinked prefix directory.
    const good = await writeLegacyBlob(join(f.agentDir, "elsewhere"), Buffer.from("third image bytes"));
    const prefix = join(f.agentDir, "image-store", "sha256", good.digest.slice(0, 2));
    await rm(prefix, { recursive: true, force: true });
    await symlink(join(f.agentDir, "elsewhere", "image-store", "sha256", good.digest.slice(0, 2)), prefix);
    expect(note(restoreLegacyMessage(legacyToolResult([good.ref]), new LegacyImageStore(f.agentDir), onFailure))).toContain("unavailable");
    expect(failures).toBe(6);
  } finally { await rm(f.agentDir, { recursive: true, force: true }); }
});

test("transcript restoration updates loaded tool results newest first within its byte budget", async () => {
  const f = await fixture();
  try {
    const older = { type: "message", id: "older", message: legacyToolResult([f.first.ref]) };
    const newer = { type: "message", id: "newer", message: legacyToolResult([f.second.ref]) };
    const pasted = { type: "custom_message", id: "pasted", customType: "image-store-context-v1", content: "Attached image sidecar.",
      details: { [LEGACY_DETAILS]: { version: 1, refs: [f.first.ref] } } };
    expect(restoreLegacyTranscript([older, pasted, newer], f.store, undefined, f.second.ref.bytes)).toBe(1);
    expect(newer.message.content[1]).toEqual({ type: "image", data: Buffer.from("second image bytes").toString("base64"), mimeType: "image/jpeg" });
    expect(older.message.content[1]).toEqual({ type: "text", text: LEGACY_PLACEHOLDER });
    expect(restoreLegacyTranscript([older, pasted, newer], f.store)).toBe(1);
    expect((older.message.content[1] as any).type).toBe("image");
  } finally { await rm(f.agentDir, { recursive: true, force: true }); }
});

test("attached-image entries render a bounded label and a native image when available", async () => {
  const f = await fixture();
  try {
    const theme = { fg: (_color: string, text: string) => text } as any;
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const preview = new LegacyImagePreview(f.first.ref, "pasted\x1b]0;evil\x07 image", f.store, theme);
    const lines = preview.render(40);
    expect(lines[0]).toContain("pasted ]0;evil image");
    expect(lines[0]).not.toContain("\x1b]");
    expect(preview.render(40)).toEqual(lines);
    setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
    const native = new LegacyImagePreview(f.first.ref, "pasted image", f.store, theme).render(40).join("\n");
    expect(native.match(/\x1b\]1337;File=/g)).toHaveLength(1);
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const missing = new LegacyImagePreview({ ...f.first.ref, digest: "a".repeat(64) }, undefined, f.store, theme);
    expect(missing.render(80)).toEqual([`↳ image ${"a".repeat(8)} · 1 KB · unavailable`]);
  } finally { await rm(f.agentDir, { recursive: true, force: true }); }
});

test("cleanup never inventories or deletes the earlier sidecar folder", async () => {
  const f = await fixture();
  try {
    const old = new Date(Date.now() - ORIGINAL_GRACE_MS * 2);
    await utimes(f.first.path, old, old);
    const store = new ImageStore(join(f.agentDir, "image-store"));
    const sessions = join(f.agentDir, "sessions"); await mkdir(sessions);
    const inventory = await inspectStorage(store, sessions);
    expect(inventory.originals).toEqual([]);
    const forged = [{ hash: f.first.digest, bytes: f.first.ref.bytes, modified: old.getTime(), inode: 0 }];
    expect(await removeUnusedOriginals(store, sessions, forged)).toEqual({ files: 0, bytes: 0 });
    expect(restoreLegacyMessage(legacyToolResult([f.first.ref]), new LegacyImageStore(f.agentDir)).content[1]!.type).toBe("image");
  } finally { await rm(f.agentDir, { recursive: true, force: true }); }
});
