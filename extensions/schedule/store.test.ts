import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createReminder } from "./schedule.ts";
import {
  acquireProjectLease,
  emptyScheduleStore,
  loadScheduleStore,
  releaseProjectLease,
  saveScheduleStore,
  scheduleStorePath,
} from "./store.ts";

test("atomically saves and securely reloads a project-scoped store", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-schedule-store-"));
  try {
    const project = join(root, "project");
    const path = scheduleStorePath(join(root, "agent"), project);
    const store = emptyScheduleStore(project);
    store.tasks.push(createReminder({ prompt: "check", runAt: 2_000 }, 1_000, "task"));
    await saveScheduleStore(path, store);
    expect(loadScheduleStore(path, project)).toEqual(store);
    expect(readFileSync(path, "utf8")).toContain('"projectCwd"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("allows one live process lease and reclaims malformed stale locks", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-schedule-lease-"));
  try {
    const path = scheduleStorePath(join(root, "agent"), join(root, "project"));
    const first = await acquireProjectLease(path);
    expect(first).toBeDefined();
    expect(await acquireProjectLease(path)).toBeUndefined();
    await releaseProjectLease(first);

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.lock`, "not-json", { mode: 0o600 });
    const reclaimed = await acquireProjectLease(path);
    expect(reclaimed).toBeDefined();
    await releaseProjectLease(reclaimed);

    writeFileSync(`${path}.lock`, "not-json", { mode: 0o600 });
    writeFileSync(`${path}.lock.reclaim`, "not-json", { mode: 0o600 });
    const recoveredThroughStaleGuard = await acquireProjectLease(path);
    expect(recoveredThroughStaleGuard).toBeDefined();
    await releaseProjectLease(recoveredThroughStaleGuard);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stale-lock contention produces exactly one owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-schedule-contention-"));
  try {
    const path = scheduleStorePath(join(root, "agent"), join(root, "project"));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.lock`, "not-json", { mode: 0o600 });

    const contenders = await Promise.all(Array.from({ length: 20 }, () => acquireProjectLease(path)));
    const owners = contenders.filter((lease) => lease !== undefined);
    expect(owners).toHaveLength(1);
    await releaseProjectLease(owners[0]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
