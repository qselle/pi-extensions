import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export const MAX_TARGETS = 256;
export const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
export const FRESH_FOR = 20_000;
const MAX_BYTES = 128 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KEY = /^[a-f0-9]{64}$/;
export const validId = (id: unknown): id is string => typeof id === "string" && UUID.test(id);
const validTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export interface Identity { key: string; pid: number; processNonce: string }
export interface Recipient extends Identity { runtimeNonce: string }
export interface Generation { version: 1; id: string; createdAt: number; issuer: string; targets: Recipient[] }
export interface Target extends Recipient {
  version: 1;
  updatedAt: number;
  state: "ready" | "waiting" | "dispatching" | "requested" | "applied" | "failed";
  generation?: string;
  requestRuntimeNonce?: string;
  attempts: number;
  retryAt?: number;
  failure?: "exception" | "refused" | "command";
}
export function identityFor(pid: number, processNonce: string): Identity {
  return { pid, processNonce, key: createHash("sha256").update(`${pid}:${processNonce}`).digest("hex") };
}
export function processIdentity(): Identity {
  // This process-local value survives extension reloads, but never PID reuse.
  const key = Symbol.for("@qselle/pi-extensions.reload-all.process.v1");
  const globals = globalThis as Record<PropertyKey, unknown>;
  const nonce = globals[key] ??= randomUUID();
  if (!validId(nonce)) throw new Error("Invalid process identity");
  return identityFor(process.pid, nonce);
}
export function runtimeDirectory(): string {
  if (!process.getuid) throw new Error("Reload coordination requires POSIX file ownership");
  if (process.env.PI_RELOAD_ALL_DIR) {
    if (!isAbsolute(process.env.PI_RELOAD_ALL_DIR)) throw new Error("PI_RELOAD_ALL_DIR must be an absolute path");
    return process.env.PI_RELOAD_ALL_DIR;
  }
  const machine = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);
  return join(tmpdir(), `qselle-pi-reload-${process.getuid()}-${machine}`);
}
function recipient(value: any): boolean {
  return !!value && Number.isSafeInteger(value.pid) && value.pid > 0 && validId(value.processNonce)
    && typeof value.key === "string" && KEY.test(value.key) && value.key === identityFor(value.pid, value.processNonce).key && validId(value.runtimeNonce);
}
export function validTarget(value: any): value is Target {
  return recipient(value) && value.version === 1 && validTime(value.updatedAt)
    && ["ready", "waiting", "dispatching", "requested", "applied", "failed"].includes(value.state)
    && Number.isInteger(value.attempts) && value.attempts >= 0 && value.attempts <= 3
    && (value.generation === undefined || validId(value.generation))
    && (value.requestRuntimeNonce === undefined || validId(value.requestRuntimeNonce))
    && (value.retryAt === undefined || validTime(value.retryAt))
    && (value.failure === undefined || ["exception", "refused", "command"].includes(value.failure))
    && (value.state === "ready" || validId(value.generation))
    && (value.state !== "requested" || value.requestRuntimeNonce === value.runtimeNonce);
}
export function validGeneration(value: any): value is Generation {
  return value?.version === 1 && validId(value.id) && validTime(value.createdAt) && typeof value.issuer === "string" && KEY.test(value.issuer)
    && Array.isArray(value.targets) && value.targets.length > 0 && value.targets.length <= MAX_TARGETS && value.targets.every(recipient)
    && new Set(value.targets.map((target: Recipient) => target.key)).size === value.targets.length
    && value.targets.some((target: Recipient) => target.key === value.issuer);
}
export const matches = (left: Recipient, right: Recipient) => left.key === right.key && left.processNonce === right.processNonce && left.runtimeNonce === right.runtimeNonce;

export class Registry {
  readonly targetsDirectory: string;
  readonly generationPath: string;
  constructor(readonly root: string, private readonly now = Date.now) {
    this.targetsDirectory = join(root, "targets");
    this.generationPath = join(root, "generation.json");
  }
  async initialize(): Promise<void> {
    if (!process.getuid) throw new Error("Reload coordination requires POSIX file ownership");
    for (const path of [this.root, this.targetsDirectory]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error("Reload registry must be an owned directory");
      await chmod(path, 0o700);
    }
  }
  targetPath(key: string): string {
    if (!KEY.test(key)) throw new Error("Invalid reload target key");
    return join(this.targetsDirectory, `${key}.json`);
  }
  private async read(path: string): Promise<unknown> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size > MAX_BYTES) return undefined;
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BYTES) return undefined;
      return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch { return undefined; }
    finally { await handle?.close(); }
  }
  private async write(path: string, value: unknown): Promise<void> {
    const contents = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error("Reload registry record too large");
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close(); handle = undefined;
      await rename(temporary, path);
    } finally {
      await handle?.close();
      await unlink(temporary).catch(() => {});
    }
  }
  async generation(): Promise<Generation | undefined> {
    const value = await this.read(this.generationPath);
    return validGeneration(value) && value.createdAt <= this.now() + 60_000 && this.now() - value.createdAt <= MAX_AGE ? value : undefined;
  }
  async target(key: string): Promise<Target | undefined> {
    const value = await this.read(this.targetPath(key));
    return validTarget(value) && value.key === key && value.updatedAt <= this.now() + 60_000 ? value : undefined;
  }
  async saveTarget(target: Target): Promise<void> {
    if (!validTarget(target)) throw new Error("Invalid reload target");
    await this.write(this.targetPath(target.key), target);
  }
  async publish(generation: Generation): Promise<void> {
    if (!validGeneration(generation)) throw new Error("Invalid reload broadcast");
    await this.write(this.generationPath, generation);
  }
  async remove(key: string): Promise<void> { await unlink(this.targetPath(key)).catch(() => {}); }
  async targets(): Promise<Target[]> {
    const result: Target[] = [];
    let scanned = 0;
    const directory = await opendir(this.targetsDirectory);
    for await (const file of directory) {
      if (++scanned > MAX_TARGETS * 4) throw new Error("Reload registry has too many entries; inspect its directory");
      if (!/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      const key = file.name.slice(0, -5);
      const target = await this.target(key);
      if (!target || this.now() - target.updatedAt > MAX_AGE) { await this.remove(key); continue; }
      result.push(target);
      if (result.length > MAX_TARGETS) throw new Error(`Reload supports at most ${MAX_TARGETS} registered sessions`);
    }
    return result;
  }
}

export async function describeStatus(registry: Registry, now: number): Promise<string> {
  const generation = await registry.generation();
  if (!generation) return `${(await registry.targets()).length} registered Pi sessions · no current broadcast`;
  const counts = { applied: 0, requested: 0, dispatching: 0, waiting: 0, failed: 0, unresponsive: 0, missing: 0 };
  for (const recipient of generation.targets) {
    const target = await registry.target(recipient.key);
    if (!target || target.processNonce !== recipient.processNonce) { counts.missing++; continue; }
    if (target.generation === generation.id && target.state === "applied") { counts.applied++; continue; }
    if (target.generation === generation.id && target.state === "failed") { counts.failed++; continue; }
    if (target.runtimeNonce !== recipient.runtimeNonce) { counts.missing++; continue; }
    if (now - target.updatedAt > FRESH_FOR) { counts.unresponsive++; continue; }
    if (target.generation === generation.id && target.state === "requested") counts.requested++;
    else if (target.generation === generation.id && target.state === "dispatching") counts.dispatching++;
    else counts.waiting++;
  }
  return `${generation.targets.length} sessions · ${Object.entries(counts).filter(([, value]) => value).map(([name, value]) => `${value} ${name}`).join(" · ")}`;
}
