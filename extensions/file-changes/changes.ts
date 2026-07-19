import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const FILE_CHANGES_ENTRY_TYPE = "file-changes-state";
export const FILE_CHANGES_ENTRY_VERSION = 1;

export type FileChangeKind = "created" | "modified";

export interface FileChange {
  path: string;
  kind: FileChangeKind;
  additions: number;
  removals: number;
}

export interface LineChangeCounts {
  additions: number;
  removals: number;
}

export type ContentChangeCounter = (path: string, before: string, after: string) => LineChangeCounts;

export interface StoredFileChanges {
  version: typeof FILE_CHANGES_ENTRY_VERSION;
  files: FileChange[];
  completedAt: number;
}

interface FileBaseline {
  absolutePath: string;
  displayPath: string;
  existed: boolean;
  content: string;
}

interface SessionEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

export function normalizeTrackedPath(cwd: string, rawPath: string): { absolutePath: string; displayPath: string } {
  const inputPath = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  const relativePath = relative(cwd, absolutePath);
  const outsideCwd = relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
  return {
    absolutePath,
    displayPath: relativePath && !outsideCwd ? relativePath : absolutePath,
  };
}

export function countChangedLines(patch: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }
  return { additions, removals };
}

export function sortFileChanges(files: Iterable<FileChange>): FileChange[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path));
}

export function decodeStoredFileChanges(value: unknown): StoredFileChanges | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<StoredFileChanges>;
  if (candidate.version !== FILE_CHANGES_ENTRY_VERSION) return undefined;
  if (!Number.isFinite(candidate.completedAt) || !Array.isArray(candidate.files)) return undefined;
  if (!candidate.files.every(isFileChange)) return undefined;
  return {
    version: FILE_CHANGES_ENTRY_VERSION,
    files: sortFileChanges(candidate.files),
    completedAt: candidate.completedAt!,
  };
}

export function restoreFileChanges(entries: readonly unknown[]): StoredFileChanges | undefined {
  let latest: StoredFileChanges | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as SessionEntryLike;
    if (candidate.type !== "custom" || candidate.customType !== FILE_CHANGES_ENTRY_TYPE) continue;
    const decoded = decodeStoredFileChanges(candidate.data);
    if (decoded && (!latest || decoded.completedAt >= latest.completedAt)) latest = decoded;
  }
  return latest;
}

export class FileChangeRun {
  private readonly baselines = new Map<string, FileBaseline>();
  private readonly changes = new Map<string, FileChange>();

  constructor(private readonly countContentChanges: ContentChangeCounter) {}

  async captureBaseline(cwd: string, rawPath: string): Promise<void> {
    const normalized = normalizeTrackedPath(cwd, rawPath);
    if (this.baselines.has(normalized.absolutePath)) return;

    try {
      const content = await readFile(normalized.absolutePath, "utf8");
      this.baselines.set(normalized.absolutePath, { ...normalized, existed: true, content });
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) return;
      this.baselines.set(normalized.absolutePath, { ...normalized, existed: false, content: "" });
    }
  }

  async refresh(cwd: string, rawPath: string): Promise<void> {
    const { absolutePath } = normalizeTrackedPath(cwd, rawPath);
    const baseline = this.baselines.get(absolutePath);
    if (!baseline) return;

    let content: string;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      return;
    }

    if (baseline.existed && content === baseline.content) {
      this.changes.delete(absolutePath);
      return;
    }

    const counts = this.countContentChanges(baseline.displayPath, baseline.content, content);
    this.changes.set(absolutePath, {
      path: baseline.displayPath,
      kind: baseline.existed ? "modified" : "created",
      ...counts,
    });
  }

  files(): FileChange[] {
    return sortFileChanges(this.changes.values());
  }
}

function isFileChange(value: unknown): value is FileChange {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FileChange>;
  return typeof candidate.path === "string"
    && candidate.path.trim().length > 0
    && (candidate.kind === "created" || candidate.kind === "modified")
    && isNonNegativeInteger(candidate.additions)
    && isNonNegativeInteger(candidate.removals);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
