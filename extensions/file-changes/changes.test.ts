import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FILE_CHANGES_ENTRY_TYPE,
  FILE_CHANGES_ENTRY_VERSION,
  FileChangeRun,
  countChangedLines,
  normalizeTrackedPath,
  restoreFileChanges,
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
  };
  const latest = {
    version: FILE_CHANGES_ENTRY_VERSION,
    files: [{ path: "new.ts", kind: "created", additions: 4, removals: 0 }],
    completedAt: 20,
  };
  const restored = restoreFileChanges([
    { type: "custom", customType: FILE_CHANGES_ENTRY_TYPE, data: older },
    { type: "custom", customType: FILE_CHANGES_ENTRY_TYPE, data: { ...latest, files: [{ path: "", kind: "created", additions: 1, removals: 0 }] } },
    { type: "custom", customType: FILE_CHANGES_ENTRY_TYPE, data: latest },
  ]);
  expect(restored).toEqual(latest);
});
