/**
 * Report rendering for `/context`.
 *
 * Layout goals, in order:
 *   1. one authoritative "Used A / B (C%)" line, matching what drives compaction
 *   2. absolute comma-grouped numbers so rows are directly comparable
 *   3. a share column, so the row that is eating the window is obvious
 *   4. heaviest regions first
 *
 * Free of pi-tui imports on purpose: rows are built and measured as plain text,
 * then coloured at the end, so the layout maths never counts ANSI.
 */

import type { Bucket, ContextReport, Section } from "./analysis.ts";

export interface ReportTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Buckets shown per section before the rest is summarised on one line. */
export const MAX_SECTION_ROWS = 6;
/** Individual entries listed under "largest entries". */
export const MAX_LARGEST_ROWS = 3;

const MIN_WIDTH = 28;
const MAX_LABEL_WIDTH = 34;
const VALUE_WIDTH = 9;
const SHARE_WIDTH = 5;
const ELLIPSIS = "…";

type RowKind = "section" | "item" | "note" | "footnote";

interface Row {
  kind: RowKind;
  indent: number;
  label: string;
  value: string;
  share?: string;
  detail?: string;
}

/** Comma-grouped integer, locale-independent. */
export function formatCount(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function sharePercent(tokens: number, total: number): string {
  if (total <= 0) return "";
  return `${Math.round((tokens / total) * 100)}%`;
}

/**
 * The authoritative usage line.
 *
 * Prefers pi's own figure, because that is what compaction reacts to; the
 * estimate is reconciled underneath the table instead of competing up here.
 */
export function summaryLine(report: ContextReport): string {
  const used = report.reported && report.reported > 0 ? report.reported : report.estimated;
  const parts: string[] = [];
  parts.push(report.window > 0
    ? `Used ${formatCount(used)} / ${formatCount(report.window)} (${sharePercent(used, report.window)})`
    : `Used ${formatCount(used)}`);
  if (report.compactAt !== undefined && report.compactAt > 0) {
    parts.push(`compacts at ${formatCount(report.compactAt)}`);
  }
  return parts.join(" · ");
}

export function renderReport(report: ContextReport, theme: ReportTheme, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  if (safeWidth < MIN_WIDTH) return [clip(`Context ${summaryLine(report)}`, safeWidth)];

  const header = clip(
    `${theme.fg("accent", "◆")} ${theme.bold("Context")}  ${theme.fg("muted", summaryLine(report))}`,
    safeWidth,
  );
  const rows = buildRows(report);
  if (rows.length === 0) return [header];

  const labelWidth = Math.min(
    Math.max(...rows.map((row) => row.indent * 2 + row.label.length)),
    Math.max(12, Math.min(MAX_LABEL_WIDTH, safeWidth - VALUE_WIDTH - SHARE_WIDTH - 1)),
  );

  const lines = [header];
  for (const row of rows) {
    const label = clip(`${" ".repeat(row.indent * 2)}${row.label}`, labelWidth).padEnd(labelWidth);
    const value = row.value.padStart(VALUE_WIDTH);
    const share = (row.share ?? "").padStart(SHARE_WIDTH);
    const detail = row.detail ? `  ${row.detail}` : "";
    // Clip and trim as plain text, then colour by column range: padding must
    // never end up inside escape codes, or trailing blanks survive the trim.
    const plainLine = clipPlain(`${label}${value}${share}${detail}`, safeWidth).replace(/\s+$/, "");
    lines.push(colorRow(row, plainLine, labelWidth, theme));
  }
  return lines;
}

function buildRows(report: ContextReport): Row[] {
  const rows: Row[] = [];
  const basis = report.estimated;

  // Heaviest region first: in a long session the conversation dwarfs the rest,
  // and reading top-down should answer "what is eating the window?" immediately.
  const sections: Array<[string, Section]> = [
    ["conversation", report.conversation],
    ["tool schemas", report.tools],
    ["system prompt", report.system],
  ];
  for (const [label, section] of sections.sort((a, b) => b[1].total - a[1].total)) {
    pushSection(rows, label, section, basis);
  }

  const largest = report.largest.slice(0, MAX_LARGEST_ROWS);
  if (largest.length > 0) {
    rows.push({ kind: "section", indent: 0, label: "largest entries", value: "" });
    for (const bucket of largest) rows.push(itemRow(bucket, 0));
  }

  rows.push({ kind: "footnote", indent: 0, label: "estimated total", value: formatCount(basis) });
  if (report.reported !== undefined && report.reported > 0) {
    rows.push({
      kind: "footnote",
      indent: 0,
      label: "provider last turn",
      value: formatCount(report.reported),
      detail: providerDetail(report),
    });
  }
  return rows;
}

/**
 * Explains pi's figure with the provider's own components.
 *
 * A large gap against the estimate is usually cache accounting, and naming the
 * parts is more useful than asserting which side is right.
 */
function providerDetail(report: ContextReport): string {
  const provider = report.provider;
  if (!provider) return "prompt + response, counts cached reuse";
  const cached = provider.cacheRead + provider.cacheWrite;
  const prompt = cached > 0
    ? `${formatCount(provider.input)} fresh + ${formatCount(cached)} cached`
    : `${formatCount(provider.input)} prompt`;
  return `${prompt} · ${formatCount(provider.output)} out`;
}

function pushSection(rows: Row[], label: string, section: Section, basis: number): void {
  if (section.total <= 0) return;
  rows.push({
    kind: "section",
    indent: 0,
    label,
    value: formatCount(section.total),
    share: sharePercent(section.total, basis),
  });

  const shown = section.buckets.slice(0, MAX_SECTION_ROWS);
  for (const bucket of shown) rows.push(itemRow(bucket, basis));

  const hidden = section.buckets.length - shown.length;
  if (hidden > 0) {
    const hiddenTokens = section.buckets.slice(MAX_SECTION_ROWS).reduce((sum, bucket) => sum + bucket.tokens, 0);
    rows.push({
      kind: "note",
      indent: 1,
      label: `${ELLIPSIS} +${hidden} more`,
      value: formatCount(hiddenTokens),
      share: sharePercent(hiddenTokens, basis),
    });
  }
}

function itemRow(bucket: Bucket, basis: number): Row {
  return {
    kind: "item",
    indent: 1,
    label: bucket.label,
    value: formatCount(bucket.tokens),
    ...(basis > 0 ? { share: sharePercent(bucket.tokens, basis) } : {}),
    ...(bucket.detail ? { detail: bucket.detail } : {}),
  };
}

function colorRow(row: Row, plainLine: string, labelWidth: number, theme: ReportTheme): string {
  const [labelColor, valueColor, shareColor] = rowColors(row);
  const valueEnd = labelWidth + VALUE_WIDTH;
  const shareEnd = valueEnd + SHARE_WIDTH;
  const cut = (from: number, to?: number) => plainLine.slice(Math.min(from, plainLine.length), to === undefined ? undefined : Math.min(to, plainLine.length));
  const segments: Array<[string, string]> = [
    [labelColor, cut(0, labelWidth)],
    [valueColor, cut(labelWidth, valueEnd)],
    [shareColor, cut(valueEnd, shareEnd)],
    ["dim", cut(shareEnd)],
  ];
  return segments
    .filter(([, text]) => text.length > 0)
    .map(([color, text]) => theme.fg(color, text))
    .join("");
}

/** Label, value, and share colours per row kind. */
function rowColors(row: Row): [string, string, string] {
  if (row.kind === "section") return ["text", "text", "muted"];
  if (row.kind === "footnote" || row.kind === "note") return ["dim", "dim", "dim"];
  return ["muted", "text", "muted"];
}

function clip(text: string, width: number): string {
  if (width <= 0) return "";
  const plain = stripAnsi(text);
  if (plain.length <= width) return text;
  // Rows are assembled from plain parts, so a plain-text clip is exact.
  return `${plain.slice(0, Math.max(0, width - 1))}${ELLIPSIS}`;
}

function clipPlain(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}${ELLIPSIS}`;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
