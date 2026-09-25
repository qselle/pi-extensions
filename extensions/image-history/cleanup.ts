import { constants } from "node:fs";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ImageStore, ORIGINAL_IMAGE } from "./storage.ts";

// Freshly stored images may not have reached the session file yet. Writers and
// cleanup also share a lease; reusing an older original refreshes its mtime.
export const ORIGINAL_GRACE_MS = 48 * 60 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/;
export interface OriginalFile { hash: string; bytes: number; modified: number; inode: number }
export interface StorageInventory {
  originals: OriginalFile[];
  candidates: OriginalFile[];
  sessionFiles: number;
  directories: string[];
}

function collectReferences(value: unknown, hashes: Set<string>): void {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    const object = current as Record<string, unknown>;
    if (ORIGINAL_IMAGE in object) {
      const reference = object[ORIGINAL_IMAGE] as { hash?: unknown } | null;
      if (!reference || typeof reference.hash !== "string" || !HASH.test(reference.hash)) throw new Error("A saved image reference is invalid; cleanup stopped.");
      hashes.add(reference.hash);
    }
    for (const child of Object.values(object)) if (child && typeof child === "object") pending.push(child);
  }
}

async function sessionReferences(roots: readonly string[], registeredFiles: readonly string[], optionalRoot: string, signal?: AbortSignal): Promise<{ hashes: Set<string>; files: number }> {
  const hashes = new Set<string>(), visited = new Set<string>();
  const knownFiles = new Set(registeredFiles.map((path) => resolve(path)));
  let files = 0, paths = 0;
  const scan = async (path: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    path = resolve(path);
    if (visited.has(path)) return;
    visited.add(path);
    if (++paths > 100_000 || depth > 64) throw new Error("Session inventory is too large; cleanup stopped.");
    let stat;
    try { stat = await lstat(path); }
    catch (error) {
      if (path === optionalRoot && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Cannot inspect session path: ${path}`, { cause: error });
    }
    if (stat.isSymbolicLink()) throw new Error(`Session path is a symlink; cleanup stopped: ${path}`);
    if (stat.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        await scan(join(path, entry.name), depth + 1);
      }
      return;
    }
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error(`Cannot safely scan session file: ${path}`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size) throw new Error("Session changed during inventory; run cleanup again.");
      const lines = createInterface({ input: handle.createReadStream({ autoClose: false, signal }), crlfDelay: Infinity });
      const strict = knownFiles.has(path) || path.endsWith(".jsonl");
      let malformed = false, records = false, sessionHeader = false, validHeader = false;
      try {
        for await (const line of lines) {
          signal?.throwIfAborted();
          if (line.length > 64 * 1024 * 1024) throw new Error("Session entry exceeds the safe inventory size.");
          if (!line.trim()) continue;
          let value: unknown;
          try { value = JSON.parse(line); }
          catch { malformed = true; if (strict) throw new Error(`Malformed saved session: ${path}`); continue; }
          records = true;
          sessionHeader ||= !!value && typeof value === "object" && (value as { type?: unknown }).type === "session";
          if (value && typeof value === "object") {
            const header = value as Record<string, unknown>;
            validHeader ||= header.type === "session" && typeof header.id === "string" && header.id.length > 0
              && Number.isSafeInteger(header.version) && Number(header.version) >= 1
              && typeof header.timestamp === "string" && typeof header.cwd === "string";
          }
          collectReferences(value, hashes);
        }
      } finally { lines.close(); }
      // Pi accepts any filename and parses individual JSON lines. Inspect every
      // regular file, including unnamed copies; unrelated binary/text files do
      // not count as sessions. Recognized or registered damaged sessions stop GC.
      if (malformed && sessionHeader) throw new Error(`Malformed saved session: ${path}`);
      if (knownFiles.has(path) && !validHeader) throw new Error(`Registered session header is missing or invalid: ${path}`);
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Session changed during inventory; run cleanup again.");
      if (strict || records) files++;
    } finally { await handle.close(); }
  };
  for (const root of roots) await scan(root, 0);
  for (const file of knownFiles) {
    if (visited.has(file)) continue;
    // Registered parent directories are required above. A file no longer there
    // was deleted or moved; any remaining copy in those directories was scanned.
    try { await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    await scan(file, 0);
  }
  return { hashes, files };
}

export async function originalFiles(store: ImageStore, signal?: AbortSignal): Promise<OriginalFile[]> {
  const originals: OriginalFile[] = [];
  let names: string[];
  try { names = await readdir(store.blobsDirectory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  for (const name of names) {
    signal?.throwIfAborted();
    if (!/^[a-f0-9]{64}\.blob$/.test(name)) continue;
    const stat = await lstat(join(store.blobsDirectory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.mode & 0o077) throw new Error("An original image file is unsafe; cleanup stopped.");
    originals.push({ hash: name.slice(0, -5), bytes: stat.size, modified: stat.mtimeMs, inode: stat.ino });
  }
  return originals;
}

async function inspect(store: ImageStore, defaultSessions: string, signal?: AbortSignal): Promise<StorageInventory> {
  const directories = [...new Set([resolve(defaultSessions), ...await store.sessionDirectories()])];
  const { hashes, files } = await sessionReferences(directories, await store.sessionFiles(), resolve(defaultSessions), signal);
  const originals = await originalFiles(store, signal);
  const cutoff = Date.now() - ORIGINAL_GRACE_MS;
  return { originals, candidates: originals.filter((file) => !hashes.has(file.hash) && file.modified < cutoff), sessionFiles: files, directories };
}

/** No deletion while preparing the user-visible inventory. */
export async function inspectStorage(store: ImageStore, defaultSessions: string, signal?: AbortSignal): Promise<StorageInventory> {
  return store.withMaintenance(async (check) => { const result = await inspect(store, defaultSessions, signal); check(); return result; });
}

/** Re-scan under the writer lease after confirmation; only remove approved files. */
export async function removeUnusedOriginals(store: ImageStore, defaultSessions: string, approved: readonly OriginalFile[], signal?: AbortSignal): Promise<{ files: number; bytes: number }> {
  return store.withMaintenance(async (check) => {
    const current = await inspect(store, defaultSessions, signal);
    const selected = new Map(approved.map((file) => [file.hash, file]));
    let files = 0, bytes = 0;
    for (const file of current.candidates) {
      const previous = selected.get(file.hash);
      if (!previous || previous.bytes !== file.bytes || previous.modified !== file.modified || previous.inode !== file.inode) continue;
      signal?.throwIfAborted(); check();
      await unlink(join(store.blobsDirectory, `${file.hash}.blob`));
      files++; bytes += file.bytes;
    }
    store.clearCache();
    return { files, bytes };
  });
}
