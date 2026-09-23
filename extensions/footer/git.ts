/** Counts from Git's machine-readable status, without reading any file content. */
export interface GitStatus {
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
  ahead: number;
  behind: number;
}

export function parseGitStatus(output: string): GitStatus {
  const status: GitStatus = { staged: 0, modified: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0 };
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) { status.ahead = Number(match[1]); status.behind = Number(match[2]); }
    } else if (record.startsWith("? ")) status.untracked++;
    else if (record.startsWith("u ")) status.conflicts++;
    else if (record.startsWith("1 ") || record.startsWith("2 ")) {
      if (record[2] !== ".") status.staged++;
      if (record[3] !== ".") status.modified++;
      // A renamed/copied entry has a second NUL-delimited source path. It can
      // itself begin with "? " or "1 "; never interpret it as another entry.
      if (record.startsWith("2 ")) i++;
    }
  }
  return status;
}

export function gitStatusLabel(status: GitStatus | undefined): string {
  if (!status) return "";
  const parts = [
    status.conflicts ? `conflicts ${status.conflicts}` : "",
    status.staged ? `staged ${status.staged}` : "",
    status.modified ? `changed ${status.modified}` : "",
    status.untracked ? `new ${status.untracked}` : "",
    status.ahead ? `ahead ${status.ahead}` : "",
    status.behind ? `behind ${status.behind}` : "",
  ].filter(Boolean);
  return parts.length ? `git ${parts.join(" ")}` : "";
}

type ReadStatus = (cwd: string, signal: AbortSignal) => Promise<GitStatus | undefined>;

/** Event-driven, debounced reads. Rendering never starts a process. */
export class GitStatusTracker {
  value: GitStatus | undefined;
  private cwd?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private pending = false;
  private generation = 0;

  constructor(private readonly read: ReadStatus, private readonly onChange: () => void, private readonly delayMs = 500) {}

  refresh(cwd: string): void {
    if (this.cwd !== cwd) { this.reset(); this.cwd = cwd; }
    this.pending = true;
    if (this.timer || this.request) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.update();
    }, this.delayMs);
    this.timer.unref?.();
  }

  reset(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.request?.abort();
    this.request = undefined;
    this.pending = false;
    this.cwd = undefined;
    this.value = undefined;
  }

  private async update(): Promise<void> {
    if (!this.cwd || !this.pending) return;
    const cwd = this.cwd;
    const generation = this.generation;
    const request = new AbortController();
    this.request = request;
    this.pending = false;
    let next: GitStatus | undefined;
    try { next = await this.read(cwd, request.signal); } catch { /* Git is optional. */ }
    if (generation !== this.generation) return;
    this.request = undefined;
    if (JSON.stringify(this.value) !== JSON.stringify(next)) {
      this.value = next;
      this.onChange();
    }
    // Events arriving during a read must get one fresh snapshot afterward.
    if (this.pending) this.refresh(cwd);
  }
}
