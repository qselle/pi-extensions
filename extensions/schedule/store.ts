import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { decodeScheduleStore, SCHEDULE_STORE_VERSION, type ScheduleStore } from "./schedule.ts";

export const MAX_SCHEDULE_STORE_BYTES = 2 * 1024 * 1024;
const MAX_LEASE_ATTEMPTS = 8;

export interface ProjectLease { path: string; token: string; pid: number }

export function scheduleStorePath(agentDir: string, cwd: string): string {
  const project = resolve(cwd);
  const key = createHash("sha256").update(project).digest("hex").slice(0, 24);
  return join(agentDir, "schedules", `${key}.json`);
}

export function emptyScheduleStore(cwd: string): ScheduleStore {
  return { version: SCHEDULE_STORE_VERSION, projectCwd: resolve(cwd), tasks: [] };
}

export function loadScheduleStore(path: string, cwd: string): ScheduleStore {
  const project = resolve(cwd);
  const content = readSecureFile(path);
  if (content === undefined) return emptyScheduleStore(project);
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error(`Schedule store ${JSON.stringify(path)} is not valid JSON.`); }
  const store = decodeScheduleStore(parsed, project);
  if (!store) throw new Error(`Schedule store ${JSON.stringify(path)} is invalid or belongs to another project.`);
  return store;
}

export async function saveScheduleStore(path: string, store: ScheduleStore): Promise<void> {
  const content = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_SCHEDULE_STORE_BYTES) throw new Error("Schedule store exceeds its 2 MiB safety limit.");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function acquireProjectLease(storePath: string): Promise<ProjectLease | undefined> {
  await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
  const path = `${storePath}.lock`;
  const reclaimPath = `${path}.reclaim`;
  for (let attempt = 0; attempt < MAX_LEASE_ATTEMPTS; attempt++) {
    const created = tryCreateLease(path);
    if (created && !pathExists(reclaimPath)) return created;
    if (created) await releaseProjectLease(created);

    const holder = readLease(path);
    if (holder && processAlive(holder.pid)) return undefined;

    const reclaim = tryCreateLease(reclaimPath);
    if (!reclaim) {
      const reclaimer = readLease(reclaimPath);
      if (reclaimer && processAlive(reclaimer.pid)) return undefined;
      await unlink(reclaimPath).catch((error) => { if (!fileError(error, "ENOENT")) throw error; });
      continue;
    }

    try {
      if (!leaseMatches(reclaim)) continue;
      const latest = readLease(path);
      if (latest && processAlive(latest.pid)) return undefined;
      await unlink(path).catch((error) => { if (!fileError(error, "ENOENT")) throw error; });
      if (!leaseMatches(reclaim)) continue;
      const recovered = tryCreateLease(path);
      if (recovered) return recovered;
    } finally {
      await releaseProjectLease(reclaim);
    }
  }
  return undefined;
}

export async function releaseProjectLease(lease: ProjectLease | undefined): Promise<void> {
  if (!lease) return;
  const holder = readLease(lease.path);
  if (holder?.token !== lease.token || holder.pid !== lease.pid) return;
  await unlink(lease.path).catch((error) => { if (!fileError(error, "ENOENT")) throw error; });
}

function readSecureFile(path: string): string | undefined {
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink() || !link.isFile()) throw new Error(`Schedule store ${JSON.stringify(path)} must be a regular non-symlink file.`);
  } catch (error) {
    if (fileError(error, "ENOENT")) return undefined;
    throw error;
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)));
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > MAX_SCHEDULE_STORE_BYTES) throw new Error(`Schedule store ${JSON.stringify(path)} is not a valid bounded file.`);
    if (process.platform !== "win32") {
      if ((stats.mode & 0o077) !== 0) throw new Error(`Schedule store ${JSON.stringify(path)} must use owner-only permissions (chmod 600).`);
      const uid = process.getuid?.();
      if (uid !== undefined && stats.uid !== uid) throw new Error(`Schedule store ${JSON.stringify(path)} must be owned by the current user.`);
    }
    return readFileSync(descriptor, "utf8");
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function tryCreateLease(path: string): ProjectLease | undefined {
  const token = randomUUID();
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ token, pid: process.pid, createdAt: Date.now() })}\n`, "utf8");
    return { path, token, pid: process.pid };
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      descriptor = undefined;
      try { unlinkSync(path); } catch { /* A later acquisition will reclaim any partial file. */ }
    }
    if (fileError(error, "EEXIST")) return undefined;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function leaseMatches(lease: ProjectLease): boolean {
  const holder = readLease(lease.path);
  return holder?.token === lease.token && holder.pid === lease.pid;
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if (fileError(error, "ENOENT")) return false; throw error; }
}

function readLease(path: string): { token: string; pid: number } | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4_096) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return typeof value.token === "string" && Number.isInteger(value.pid) && (value.pid as number) > 0
      ? { token: value.token, pid: value.pid as number }
      : undefined;
  } catch { return undefined; }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return fileError(error, "EPERM"); }
}

function fileError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === code);
}
