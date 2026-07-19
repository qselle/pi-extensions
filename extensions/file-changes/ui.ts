import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FileChange } from "./changes.ts";

const MAX_VISIBLE_FILES = 8;

export type FileChangesPhase = "live" | "last";

export interface FileChangesDisplay {
  phase: FileChangesPhase;
  files: readonly FileChange[];
}

export function fileChangesTitle(display: FileChangesDisplay, theme: Theme): string {
  const phase = display.phase === "live" ? "live" : "last run";
  return `${theme.bold(" Changed files ")}${theme.fg("dim", `· ${phase} `)}`;
}

export function renderFileChangesBody(
  display: FileChangesDisplay,
  width: number,
  maxHeight: number,
  theme: Theme,
): string[] {
  if (width < 10 || maxHeight <= 0 || display.files.length === 0) return [];

  const includeSpacer = maxHeight >= 3;
  const rowsForFiles = Math.max(0, maxHeight - 1 - (includeSpacer ? 1 : 0));
  const visibleCapacity = Math.min(MAX_VISIBLE_FILES, rowsForFiles);
  const needsOverflow = display.files.length > visibleCapacity;
  const fileCapacity = needsOverflow && visibleCapacity >= 2 ? visibleCapacity - 1 : visibleCapacity;
  const visibleFiles = display.files.slice(0, fileCapacity);
  const lines = visibleFiles.map((file) => renderFileRow(file, width, theme));

  if (needsOverflow && visibleCapacity >= 2) {
    lines.push(theme.fg("dim", `  … ${display.files.length - visibleFiles.length} more`));
  }
  if (includeSpacer) lines.push("");
  lines.push(renderTotals(display.files, theme));

  return lines.slice(0, maxHeight).map((line) => truncateToWidth(line, width, ""));
}

export function compactFilePath(filePath: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(filePath) <= maxWidth) return filePath;

  const separator = filePath.includes("\\") && !filePath.includes("/") ? "\\" : "/";
  const segments = filePath.split(/[\\/]/u).filter(Boolean);
  const leaf = segments.at(-1) ?? filePath;
  const shortPrefix = `…${separator}`;
  if (visibleWidth(shortPrefix) + visibleWidth(leaf) <= maxWidth) {
    const first = filePath.startsWith(separator) ? "" : segments[0];
    const contextual = first && first !== leaf
      ? `${first}${separator}${shortPrefix}${leaf}`
      : `${shortPrefix}${leaf}`;
    return visibleWidth(contextual) <= maxWidth ? contextual : `${shortPrefix}${leaf}`;
  }

  if (maxWidth === 1) return "…";
  const tailWidth = maxWidth - 1;
  const leafWidth = visibleWidth(leaf);
  return `…${sliceByColumn(leaf, Math.max(0, leafWidth - tailWidth), tailWidth, true)}`;
}

function renderFileRow(file: FileChange, width: number, theme: Theme): string {
  const marker = file.kind === "created" ? theme.fg("success", "+") : theme.fg("accent", "~");
  const counts = [
    file.additions > 0 ? theme.fg("success", `+${file.additions}`) : "",
    file.removals > 0 ? theme.fg("error", `-${file.removals}`) : "",
  ].filter(Boolean).join(" ");
  const prefix = `${marker} `;
  const countGap = counts ? 1 : 0;
  const pathWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(counts) - countGap);
  const filePath = compactFilePath(file.path, pathWidth);
  if (!counts) return `${prefix}${filePath}`;
  const gap = " ".repeat(Math.max(1, width - visibleWidth(prefix) - visibleWidth(filePath) - visibleWidth(counts)));
  return `${prefix}${filePath}${gap}${counts}`;
}

function renderTotals(files: readonly FileChange[], theme: Theme): string {
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const removals = files.reduce((total, file) => total + file.removals, 0);
  const pieces = [theme.fg("dim", `${files.length} ${files.length === 1 ? "file" : "files"}`)];
  if (additions > 0) pieces.push(theme.fg("success", `+${additions}`));
  if (removals > 0) pieces.push(theme.fg("error", `-${removals}`));
  return pieces.join("  ");
}
