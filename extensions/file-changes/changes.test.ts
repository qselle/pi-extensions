import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  FILE_CHANGES_ENTRY_TYPE,
  FILE_CHANGES_ENTRY_VERSION,
  FileChangeRun,
  countChangedLines,
  normalizeTrackedPath,
  restoreFileChanges,
  type StoredFileChanges,
} from "./changes.ts";

const countFixtureChanges = (_path: string, before: string, after: string) => {
  const beforeLines = before.split("\n").filter(Boolean);
  const afterLines = after.split("\n").filter(Boolean);
  const remaining = [...beforeLines];
  let additions = 0;
  for (const line of afterLines) {
    const match = remaining.indexOf(line);
    if (match >= 0) remaining.splice(match, 1);
    else additions++;
  }
  return { additions, removals: remaining.length };
};

test("counts patch body lines without counting file headers", () => {
  const patch = [
    "--- src/example.ts",
    "+++ src/example.ts",
    "@@ -1,2 +1,3 @@",
    " unchanged",
    "-before",
    "+after",
    "+extra",
  ].join("\n");
  expect(countChangedLines(patch)).toEqual({ additions: 2, removals: 1 });
});

test("tracks net changes from the first mutation and removes reverted files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-file-changes-"));
  const filePath = join(cwd, "src.ts");
  try {
    await writeFile(filePath, "one\ntwo\n");
    const run = new FileChangeRun(countFixtureChanges);
    await run.captureBaseline(cwd, "@src.ts");
    await writeFile(filePath, "one\nchanged\nthree\n");
    await run.refresh(cwd, "src.ts");

    expect(run.files()).toEqual([{
      path: "src.ts",
      kind: "modified",
      additions: 2,
      removals: 1,
    }]);

    await writeFile(filePath, "one\ntwo\n");
    await run.refresh(cwd, "src.ts");
    expect(run.files()).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tracks newly written files and normalizes paths relative to the session cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-file-changes-"));
  const filePath = join(cwd, "new-file.ts");
  try {
    const normalized = normalizeTrackedPath(cwd, "@new-file.ts");
    expect(normalized.absolutePath).toBe(filePath);
    expect(normalized.displayPath).toBe("new-file.ts");

    const run = new FileChangeRun(countFixtureChanges);
    await run.captureBaseline(cwd, "new-file.ts");
    await writeFile(filePath, "alpha\nbeta\n");
    await run.refresh(cwd, "new-file.ts");
    expect(run.files()).toEqual([{
      path: "new-file.ts",
      kind: "created",
      additions: 2,
      removals: 0,
    }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("restores only the latest valid summary on the active branch", () => {
  const older = {
    version: FILE_CHANGES_ENTRY_VERSION,
    files: [{ path: "older.ts", kind: "modified", additions: 1, removals: 1 }],
    completedAt: 10,
  } satisfies StoredFileChanges;
  const latest = {
    version: FILE_CHANGES_ENTRY_VERSION,
    files: [{ path: "new.ts", kind: "created", additions: 4, removals: 0 }],
    completedAt: 20,
  } satisfies StoredFileChanges;
  const restored = restoreFileChanges([
    { type: "custom", customType: FILE_CHANGES_ENTRY_TYPE, data: older },
    { type: "custom", customType: FILE_CHANGES_ENTRY_TYPE, data: { ...latest, files: [{ path: "", kind: "created", additions: 1, removals: 0 }] } },
    { type: "custom", customType: FILE_CHANGES_ENTRY_TYPE, data: latest },
  ]);
  expect(restored).toEqual(latest);
});

test("counts patch content beginning with header-like plus/minus sequences", () => {
  expect(countChangedLines("--- file\n+++ file\n@@ -1,2 +1,2 @@\n---old-content\n----old-content\n+++new-content\n++++new-content")).toEqual({ additions: 2, removals: 2 });
});

test("restoration follows append order even if the system clock moves backward", () => {
  const record = (path: string, completedAt: number) => ({ type: "custom", customType: FILE_CHANGES_ENTRY_TYPE, data: { version: 1, files: [{ path, kind: "modified", additions: 1, removals: 0 }], completedAt } });
  expect(restoreFileChanges([record("old.ts", 200), record("latest.ts", 100)])?.files[0]?.path).toBe("latest.ts");
});

test("concurrent baseline requests keep one baseline through repeated writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-file-changes-concurrent-"));
  try {
    const path = join(cwd, "file.ts");
    await writeFile(path, "original\n");
    const run = new FileChangeRun(countFixtureChanges);
    await Promise.all(Array.from({ length: 8 }, () => run.captureBaseline(cwd, "file.ts")));
    await writeFile(path, "replacement\nextra\n");
    await run.captureBaseline(cwd, "file.ts");
    await Promise.all([run.refresh(cwd, "file.ts"), run.refresh(cwd, "file.ts")]);
    expect(run.files()[0]).toMatchObject({ additions: 2, removals: 1 });
    await writeFile(path, "original\n");
    await run.refresh(cwd, "file.ts");
    expect(run.files()).toEqual([]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("deduplicates in-flight baseline reads and ignores stale refresh completions", async () => {
  const reads: Array<(value: string) => void> = [];
  const run = new FileChangeRun((_path, _before, after) => ({ additions: after === "newest" ? 2 : 1, removals: 0 }), () => new Promise<string>((resolve) => reads.push(resolve)));
  const first = run.captureBaseline("/project", "file.ts");
  const second = run.captureBaseline("/project", "file.ts");
  expect(reads).toHaveLength(1);
  reads[0]!("original"); await Promise.all([first, second]);
  const older = run.refresh("/project", "file.ts");
  const newer = run.refresh("/project", "file.ts");
  reads[2]!("newest"); await newer;
  reads[1]!("older"); await older;
  expect(run.files()[0]?.additions).toBe(2);
});

test("home-relative tool paths resolve consistently with Pi", () => {
  expect(normalizeTrackedPath("/project", "~/example.ts").absolutePath).toBe(join(homedir(), "example.ts"));
  expect(normalizeTrackedPath("/project", "@~/example.ts").absolutePath).toBe(join(homedir(), "example.ts"));
});
