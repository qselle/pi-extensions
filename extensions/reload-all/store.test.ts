import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Registry, MAX_AGE, MAX_TARGETS, describeStatus, identityFor, validGeneration, validTarget, type Target } from "./store.ts";
const roots: string[] = [];
const now = 1_800_000_000_000;
const target = (pid = 100): Target => ({ ...identityFor(pid, randomUUID()), runtimeNonce: randomUUID(), version: 1, updatedAt: now, state: "ready", attempts: 0 });
async function registry() { const root = await mkdtemp(join(tmpdir(), "pi-reload-store-")); roots.push(root); const store = new Registry(root, () => now); await store.initialize(); return store; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
test("registry creates private atomic records and validates exact process identity", async () => {
  const store = await registry(); const record = target();
  await store.saveTarget(record);
  expect((await lstat(store.root)).mode & 0o777).toBe(0o700);
  expect((await lstat(store.targetPath(record.key))).mode & 0o777).toBe(0o600);
  expect(await store.target(record.key)).toEqual(record);
  expect(validTarget({ ...record, pid: 101 })).toBe(false);
  expect(validTarget({ ...record, attempts: 99 })).toBe(false);
  expect(validTarget({ ...record, state: "requested" })).toBe(false);
  const generation = { version: 1 as const, id: randomUUID(), createdAt: now, issuer: record.key, targets: [record] };
  await store.publish(generation);
  expect(await store.generation()).toEqual(generation);
  expect(validGeneration({ ...generation, targets: [record, record] })).toBe(false);
  expect(validGeneration({ ...generation, createdAt: Infinity })).toBe(false);
  await expect(store.target("../outside")).rejects.toThrow("Invalid");
});
test("registry refuses symlinked or nonprivate files and bounds read sizes", async () => {
  const store = await registry(); const record = target(); const outside = join(store.root, "outside");
  await writeFile(outside, JSON.stringify(record), { mode: 0o600 });
  await symlink(outside, store.targetPath(record.key));
  expect(await store.target(record.key)).toBeUndefined();
  expect((await readFile(outside, "utf8"))).toContain(record.runtimeNonce);
  await rm(store.targetPath(record.key));
  await store.saveTarget(record); await chmod(store.targetPath(record.key), 0o644);
  expect(await store.target(record.key)).toBeUndefined();
  await chmod(store.targetPath(record.key), 0o600);
  await writeFile(store.targetPath(record.key), "x".repeat(129 * 1024));
  expect(await store.target(record.key)).toBeUndefined();
});
test("registry refuses symlinked coordination directories", async () => {
  const store = await registry(); const outside = join(store.root, "real"); await mkdir(outside);
  const link = join(store.root, "link"); await symlink(outside, link);
  await expect(new Registry(link).initialize()).rejects.toThrow("owned directory");
});
test("stale suspended targets remain eligible for seven days; older orphans are pruned", async () => {
  const store = await registry(); const suspended = { ...target(), updatedAt: now - 60_000 };
  const orphan = { ...target(101), updatedAt: now - MAX_AGE - 1 };
  await store.saveTarget(suspended); await store.saveTarget(orphan);
  expect(await store.targets()).toEqual([suspended]);
  expect(await store.target(orphan.key)).toBeUndefined();
  await store.publish({ version: 1, id: randomUUID(), createdAt: now, issuer: suspended.key, targets: [suspended] });
  expect(await describeStatus(store, now)).toContain("1 unresponsive");
});
test("status distinguishes waiting, requested, replacement acknowledgement and missing", async () => {
  const store = await registry(); const first = target(); const second = target(101); const id = randomUUID();
  await store.saveTarget(first); await store.saveTarget(second);
  await store.publish({ version: 1, id, createdAt: now, issuer: first.key, targets: [first, second] });
  expect(await describeStatus(store, now)).toBe("2 sessions · 2 waiting");
  await store.saveTarget({ ...first, generation: id, state: "requested", requestRuntimeNonce: first.runtimeNonce, attempts: 1 });
  expect(await describeStatus(store, now)).toBe("2 sessions · 1 requested · 1 waiting");
  await store.saveTarget({ ...first, generation: id, state: "applied", runtimeNonce: randomUUID(), attempts: 1 });
  await store.remove(second.key);
  expect(await describeStatus(store, now)).toBe("2 sessions · 1 applied · 1 missing");
});
test("capacity overflow rejects the broadcast instead of taking a partial snapshot", async () => {
  const store = await registry();
  for (let index = 0; index <= MAX_TARGETS; index++) await store.saveTarget(target(1000 + index));
  await expect(store.targets()).rejects.toThrow("at most 256");
  expect(await store.generation()).toBeUndefined();
});
