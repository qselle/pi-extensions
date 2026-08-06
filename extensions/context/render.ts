/**
 * Report rendering for `/context`.
 *
 * Free of pi-tui imports on purpose: rows are built and measured as plain text,
 * then coloured at the end. That keeps the layout maths honest (no ANSI in the
 * width calculation) and keeps these tests hermetic. Token formatting is reused
 * from the footer so both surfaces spell numbers the same way.
 */

import { formatPercent, formatTokens } from "../footer/format.ts";
import type { Bucket, ContextReport, Section } from "./analysis.ts";

export interface ReportTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Buckets shown per section before the rest is summarised on one line. */
export const MAX_SECTION_ROWS = 6;
/** Individual entries listed under "largest entries". */
export const MAX_LARGEST_ROWS = 3;

const MIN_WIDTH = 24;
const ELLIPSIS = "…";

type RowKind = "section" | "item" | "note";

interface Row {
  kind: RowKind;
  indent: number;
  label: string;
  value: string;
  detail?: string;
}

/** The one-line summary, e.g. `Context · 28.2K est · 11% of 258K · compaction at 238K`. */
export function summaryLine(report: ContextReport): string {
  const parts = [`${formatTokens(report.estimated)} est`];
  if (report.reported !== undefined && report.reported > 0) {
    parts.push(`${formatTokens(report.reported)} reported`);
  }
  if (report.window > 0) {
    const used = report.reported && report.reported > 0 ? report.reported : report.estimated;
    parts.push(`${formatPercent((used / report.window) * 100)} of ${formatTokens(report.window)}`);
  }
  if (report.compactAt !== undefined && report.compactAt > 0) {
    parts.push(`compaction at ${formatTokens(report.compactAt)}`);
  }
  return parts.join(" · ");
}

export function renderReport(report: ContextReport, theme: ReportTheme, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const header = clip(
    `${theme.fg("accent", "◆")} ${theme.bold("Context")} ${theme.fg("muted", summaryLine(report))}`,
    safeWidth,
  );
  if (safeWidth < MIN_WIDTH) return [clip(`Context ${summaryLine(report)}`, safeWidth)];

  const rows = buildRows(report);
  if (rows.length === 0) return [header];

  const labelWidth = Math.min(
    Math.max(...rows.map((row) => indentOf(row) + row.label.length)),
    Math.max(8, safeWidth - 8),
  );
  const lines = [header];
  for (const row of rows) {
    const label = clip(`${" ".repeat(indentOf(row))}${row.label}`, labelWidth).padEnd(labelWidth);
    const value = row.value.padStart(6);
    const detail = row.detail ? ` ${row.detail}` : "";
    lines.push(clip(colorRow(row, label, value, detail, theme), safeWidth));
  }
  return lines;
}

function buildRows(report: ContextReport): Row[] {
  const rows: Row[] = [];
  pushSection(rows, "system prompt", report.system);
  pushSection(rows, "tool schemas", report.tools);
  pushSection(rows, "conversation", report.conversation);

  const largest = report.largest.slice(0, MAX_LARGEST_ROWS);
  if (largest.length > 0) {
    rows.push({ kind: "section", indent: 0, label: "largest entries", value: "" });
    for (const bucket of largest) rows.push(itemRow(bucket));
  }
  return rows;
}

function pushSection(rows: Row[], label: string, section: Section): void {
  if (section.total <= 0) return;
  rows.push({ kind: "section", indent: 0, label, value: formatTokens(section.total) });

  const shown = section.buckets.slice(0, MAX_SECTION_ROWS);
  for (const bucket of shown) rows.push(itemRow(bucket));

  const hidden = section.buckets.length - shown.length;
  if (hidden > 0) {
    const hiddenTokens = section.buckets.slice(MAX_SECTION_ROWS).reduce((sum, bucket) => sum + bucket.tokens, 0);
    rows.push({
      kind: "note",
      indent: 1,
      label: `${ELLIPSIS} +${hidden} more`,
      value: formatTokens(hiddenTokens),
    });
  }
}

function itemRow(bucket: Bucket): Row {
  return {
    kind: "item",
    indent: 1,
    label: bucket.label,
    value: formatTokens(bucket.tokens),
    ...(bucket.detail ? { detail: bucket.detail } : {}),
  };
}

function colorRow(row: Row, label: string, value: string, detail: string, theme: ReportTheme): string {
  if (row.kind === "section") {
    return `${theme.fg("text", label)}${theme.fg("text", value)}${theme.fg("dim", detail)}`;
  }
  if (row.kind === "note") {
    return `${theme.fg("dim", label)}${theme.fg("dim", value)}`;
  }
  return `${theme.fg("muted", label)}${theme.fg("dim", value)}${theme.fg("dim", detail)}`;
}

function indentOf(row: Row): number {
  return row.indent * 2;
}

function clip(text: string, width: number): string {
  if (width <= 0) return "";
  const plain = stripAnsi(text);
  if (plain.length <= width) return text;
  // Rows are assembled from plain parts, so a plain-text clip is exact.
  return `${plain.slice(0, Math.max(0, width - 1))}${ELLIPSIS}`;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
