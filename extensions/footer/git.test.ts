import { expect, test } from "bun:test";
import { GitStatusTracker, gitStatusLabel, parseGitStatus, type GitStatus } from "./git.ts";

const clean = (): GitStatus => ({ staged: 0, modified: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0 });

test("Git records count both index and worktree changes, conflicts and upstream distance", () => {
  const result = parseGitStatus([
    "# branch.head feature/display", "# branch.ab +2 -3",
    "1 M. N... 100644 100644 100644 abc def staged.txt",
    "1 .M N... 100644 100644 100644 abc def modified.txt",
    "1 MM N... 100644 100644 100644 abc def both.txt",
    "2 R. N... 100644 100644 100644 abc def R100 new name.txt", "? old\nname.txt",
    "u UU N... 100644 100644 100644 100644 abc def ghi conflict.txt",
    "? new-directory/", "! ignored/", "",
  ].join("\0"));
  expect(result).toEqual({ staged: 3, modified: 2, untracked: 1, conflicts: 1, ahead: 2, behind: 3 });
  expect(gitStatusLabel(result)).toBe("git conflicts 1 staged 3 changed 2 new 1 ahead 2 behind 3");
  expect(gitStatusLabel(parseGitStatus("# branch.head (detached)\0"))).toBe("");
  expect(gitStatusLabel(undefined)).toBe("");
});

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Git snapshot");
    await Bun.sleep(2);
  }
}

test("Git refreshes coalesce, rerun after in-flight events, and stay idle afterward", async () => {
  const reads: Array<{ cwd: string; signal: AbortSignal; resolve: (value: GitStatus | undefined) => void }> = [];
  let changes = 0;
  const tracker = new GitStatusTracker((cwd, signal) => new Promise((resolve) => reads.push({ cwd, signal, resolve })), () => changes++, 1);
  try {
    tracker.refresh("/a"); tracker.refresh("/a"); tracker.refresh("/a");
    await waitFor(() => reads.length === 1);
    tracker.refresh("/a"); tracker.refresh("/a");
    expect(reads).toHaveLength(1);
    reads[0]!.resolve({ ...clean(), staged: 1 });
    await waitFor(() => reads.length === 2);
    expect(tracker.value?.staged).toBe(1);
    reads[1]!.resolve({ ...clean(), staged: 2 });
    await waitFor(() => tracker.value?.staged === 2);
    await Bun.sleep(5);
    expect(reads).toHaveLength(2);
    expect(changes).toBe(2);
    tracker.refresh("/a");
    await waitFor(() => reads.length === 3);
    reads[2]!.resolve({ ...clean(), staged: 2 });
    await Bun.sleep(5);
    expect(changes).toBe(2);
  } finally { tracker.reset(); }
});

test("switching sessions aborts old reads and suppresses late snapshots", async () => {
  const reads: Array<{ signal: AbortSignal; resolve: (value: GitStatus) => void }> = [];
  const tracker = new GitStatusTracker((_cwd, signal) => new Promise((resolve) => reads.push({ signal, resolve })), () => {}, 1);
  try {
    tracker.refresh("/old");
    await waitFor(() => reads.length === 1);
    tracker.refresh("/new");
    expect(reads[0]!.signal.aborted).toBe(true);
    await waitFor(() => reads.length === 2);
    reads[1]!.resolve({ ...clean(), untracked: 1 });
    await waitFor(() => tracker.value?.untracked === 1);
    reads[0]!.resolve({ ...clean(), staged: 99 });
    await Bun.sleep(5);
    expect(tracker.value).toEqual({ ...clean(), untracked: 1 });
    tracker.reset();
    tracker.refresh("/cancelled");
    tracker.reset();
    await Bun.sleep(5);
    expect(reads).toHaveLength(2);
    expect(tracker.value).toBeUndefined();
  } finally { tracker.reset(); }
});

test("an unavailable repository clears stale Git state without failing the footer", async () => {
  let failed = false;
  let changes = 0;
  const tracker = new GitStatusTracker(async () => {
    if (failed) throw new Error("git unavailable");
    return { ...clean(), conflicts: 1 };
  }, () => changes++, 1);
  try {
    tracker.refresh("/repo");
    await waitFor(() => !!tracker.value);
    failed = true;
    tracker.refresh("/repo");
    await waitFor(() => tracker.value === undefined);
    expect(changes).toBe(2);
  } finally { tracker.reset(); }
});
