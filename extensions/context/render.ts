import { visibleWidth, truncateToWidth, sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
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

/** Prefer Pi's usage count, which drives compaction; use the estimate when unavailable. */
export function summaryLine(report: ContextReport): string {
  const measured = report.reported !== undefined;
  const used = measured ? report.reported! : report.estimated;
  const label = measured ? "Used" : "Estimated";
  return report.window > 0
    ? `${label} ${formatCount(used)} / ${formatCount(report.window)} (${sharePercent(used, report.window)})`
    : `${label} ${formatCount(used)}`;
}

export function renderReport(report: ContextReport, theme: ReportTheme, width: number, expanded = false): string[] {
  if (width <= 0) return [];
  const safeWidth = Math.max(1, Math.floor(width));
  if (safeWidth < MIN_WIDTH) return [clipPlain(`Context ${summaryLine(report)}`, safeWidth)];

  const header = clip(
    `${theme.fg("accent", "◆")} ${theme.bold("Context")}  ${theme.fg("muted", summaryLine(report))}`,
    safeWidth,
  );
  const rows = buildRows(report, expanded);
  if (rows.length === 0) return [header];

  const labelWidth = Math.min(
    Math.max(...rows.map((row) => row.indent * 2 + visibleWidth(row.label))),
    Math.max(12, Math.min(MAX_LABEL_WIDTH, safeWidth - VALUE_WIDTH - SHARE_WIDTH - 1)),
  );

  const lines = [header];
  for (const row of rows) {
    const clippedLabel = clipPlain(`${" ".repeat(row.indent * 2)}${row.label}`, labelWidth);
    const label = clippedLabel + " ".repeat(Math.max(0, labelWidth - visibleWidth(clippedLabel)));
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

function buildRows(report: ContextReport, expanded: boolean): Row[] {
  const rows: Row[] = [];
  const basis = report.estimated;

  const sections: Array<[string, Section]> = [
    ["conversation", report.conversation],
    ["tool schemas", report.tools],
    ["system prompt", report.system],
  ];
  for (const [label, section] of sections.sort((a, b) => b[1].total - a[1].total)) {
    pushSection(rows, label, section, basis, expanded);
  }

  const largest = expanded ? report.largest : report.largest.slice(0, MAX_LARGEST_ROWS);
  if (largest.length > 0) {
    rows.push({ kind: "section", indent: 0, label: "largest entries", value: "" });
    for (const bucket of largest) rows.push(itemRow(bucket, 0));
  }

  rows.push({ kind: "footnote", indent: 0, label: "estimated total", value: formatCount(basis) });
  if (report.reported !== undefined) {
    rows.push({
      kind: "footnote",
      indent: 0,
      label: "pi context total",
      value: formatCount(report.reported),
      detail: providerDetail(report),
    });
  }
  return rows;
}

/** Show provider usage components alongside the independent estimate. */
function providerDetail(report: ContextReport): string {
  const provider = report.provider;
  if (!provider) return "includes provider cache accounting";
  const cached = provider.cacheRead + provider.cacheWrite;
  const prompt = cached > 0
    ? `${formatCount(provider.input)} fresh + ${formatCount(cached)} cached`
    : `${formatCount(provider.input)} prompt`;
  return `last turn: ${prompt} · ${formatCount(provider.output)} out`;
}

function pushSection(rows: Row[], label: string, section: Section, basis: number, expanded: boolean): void {
  if (section.total <= 0) return;
  rows.push({
    kind: "section",
    indent: 0,
    label,
    value: formatCount(section.total),
    share: sharePercent(section.total, basis),
  });

  const shown = expanded ? section.buckets : section.buckets.slice(0, MAX_SECTION_ROWS);
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
      detail: "expand to view",
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
  const cut = (from: number, to?: number) => sliceByColumn(plainLine, from, Math.max(0, (to ?? visibleWidth(plainLine)) - from));
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

function rowColors(row: Row): [string, string, string] {
  if (row.kind === "section") return ["text", "text", "muted"];
  if (row.kind === "footnote" || row.kind === "note") return ["dim", "dim", "dim"];
  return ["muted", "text", "muted"];
}

function clip(text: string, width: number): string {
  return width <= 0 ? "" : truncateToWidth(text, width, ELLIPSIS);
}

function clipPlain(text: string, width: number): string {
  return stripTerminalSequences(clip(text, width));
}
