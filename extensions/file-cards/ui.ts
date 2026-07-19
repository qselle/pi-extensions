import {
  getLanguageFromPath,
  highlightCode,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

export const COLLAPSED_BODY_ROWS = 9;
export const EXPANDED_BODY_ROWS = 20;
export const FILE_CARD_MAX_WIDTH = 96;

export type FileCardOperation = "edit" | "write";

type CardStatus = "pending" | "success" | "error";
type DiffMarker = " " | "+" | "-";

interface EditReplacement {
  oldText: string;
  newText: string;
}

interface FileCardArgs {
  path?: unknown;
  content?: unknown;
  edits?: unknown;
  oldText?: unknown;
  newText?: unknown;
}

interface ToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
  details?: { diff?: unknown };
}

interface PreviewRow {
  marker?: DiffMarker;
  lineNumber?: string;
  content: string;
  meta?: boolean;
}

interface CardModel {
  operation: FileCardOperation;
  status: CardStatus;
  path: string;
  language?: string;
  rows: PreviewRow[];
  additions: number;
  removals: number;
  changes: number;
  lines: number;
  bytes: number;
  error?: string;
}

/**
 * One stable component owns the complete edit/write presentation. The call
 * renderer creates it and the result renderer settles it in place, avoiding a
 * second result box or a transient full-height transcript block.
 */
export class FileMutationCard implements Component {
  private args: FileCardArgs = {};
  private status: CardStatus = "pending";
  private result?: ToolResultLike;
  private isError = false;
  private expanded = false;
  private theme: Theme;
  private revision = 0;
  private cached?: { width: number; revision: number; lines: string[] };

  constructor(
    private readonly operation: FileCardOperation,
    theme: Theme,
  ) {
    this.theme = theme;
  }

  setCall(args: FileCardArgs | undefined, expanded: boolean, theme: Theme): void {
    const nextArgs = args ?? {};
    const changed = this.status === "pending"
      || this.args !== nextArgs
      || this.expanded !== expanded
      || this.theme !== theme;
    this.args = nextArgs;
    this.expanded = expanded;
    this.theme = theme;
    if (changed) this.touch();
  }

  setResult(result: ToolResultLike, isError: boolean, expanded: boolean, theme: Theme): void {
    const nextStatus = isError ? "error" : "success";
    const changed = this.result !== result
      || this.isError !== isError
      || this.status !== nextStatus
      || this.expanded !== expanded
      || this.theme !== theme;
    this.result = result;
    this.isError = isError;
    this.status = nextStatus;
    this.expanded = expanded;
    this.theme = theme;
    if (changed) this.touch();
  }

  render(width: number): string[] {
    const cardWidth = Math.min(FILE_CARD_MAX_WIDTH, Math.max(1, width));
    if (this.cached?.width === cardWidth && this.cached.revision === this.revision) {
      return this.cached.lines;
    }

    const model = buildModel(this.operation, this.args, this.status, this.result, this.isError);
    const lines = renderCard(model, cardWidth, this.expanded, this.theme);
    this.cached = { width: cardWidth, revision: this.revision, lines };
    return lines;
  }

  invalidate(): void {
    this.cached = undefined;
    this.revision += 1;
  }

  private touch(): void {
    this.cached = undefined;
    this.revision += 1;
  }
}

export function renderCard(model: CardModel, width: number, expanded: boolean, theme: Theme): string[] {
  if (width < 8) {
    return [truncateToWidth(`${model.operation} ${model.path}`, width, "")];
  }

  const bodyLimit = expanded ? EXPANDED_BODY_ROWS : COLLAPSED_BODY_ROWS;
  const bounded = boundRows(model.rows, bodyLimit);
  const body = colorizeRows(bounded.rows, model.language, theme);
  const header = renderHeader(model, width, theme);
  const footer = renderFooter(model, width, expanded, bounded.hidden, theme);
  const fallback = model.status === "error"
    ? theme.fg("error", compactError(model.error ?? "File operation failed"))
    : theme.fg("dim", model.status === "pending" ? "Preparing file change…" : "No preview available");
  const content = body.length > 0 ? body : [fallback];

  return [
    header,
    ...content.map((line) => renderBodyLine(line, width, theme)),
    footer,
  ];
}

function buildModel(
  operation: FileCardOperation,
  args: FileCardArgs,
  status: CardStatus,
  result: ToolResultLike | undefined,
  isError: boolean,
): CardModel {
  const path = typeof args.path === "string" && args.path.trim() ? args.path : "(path pending)";
  const language = getLanguageFromPath(path);
  const error = isError ? resultText(result) || "File operation failed" : undefined;

  if (operation === "write") {
    const content = typeof args.content === "string" ? normalizeText(args.content) : "";
    const rows = content === ""
      ? []
      : content.split("\n").map((line, index) => ({ lineNumber: String(index + 1), content: line }));
    return {
      operation,
      status,
      path,
      language,
      rows: error ? errorRows(error) : rows,
      additions: 0,
      removals: 0,
      changes: 0,
      lines: rows.length,
      bytes: new TextEncoder().encode(typeof args.content === "string" ? args.content : "").byteLength,
      error,
    };
  }

  const diff = !isError && typeof result?.details?.diff === "string" ? result.details.diff : undefined;
  const replacements = normalizeEdits(args);
  const rows = error
    ? errorRows(error)
    : diff
      ? parseDiff(diff)
      : proposalRows(replacements);
  const additions = rows.filter((row) => row.marker === "+").length;
  const removals = rows.filter((row) => row.marker === "-").length;
  return {
    operation,
    status,
    path,
    language,
    rows,
    additions,
    removals,
    changes: replacements.length,
    lines: 0,
    bytes: 0,
    error,
  };
}

function normalizeEdits(args: FileCardArgs): EditReplacement[] {
  if (Array.isArray(args.edits)) {
    return args.edits.filter((edit): edit is EditReplacement => Boolean(
      edit && typeof edit === "object"
      && typeof (edit as EditReplacement).oldText === "string"
      && typeof (edit as EditReplacement).newText === "string",
    ));
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    return [{ oldText: args.oldText, newText: args.newText }];
  }
  return [];
}

function proposalRows(edits: readonly EditReplacement[]): PreviewRow[] {
  const rows: PreviewRow[] = [];
  edits.forEach((edit, index) => {
    if (edits.length > 1) rows.push({ content: `change ${index + 1}`, meta: true });
    for (const line of normalizeText(edit.oldText).split("\n")) rows.push({ marker: "-", content: line });
    for (const line of normalizeText(edit.newText).split("\n")) rows.push({ marker: "+", content: line });
  });
  return rows;
}

function parseDiff(diff: string): PreviewRow[] {
  return normalizeText(diff).split("\n").map((line) => {
    const match = line.match(/^([ +\-])(\s*\d*)\s(.*)$/u);
    if (!match) return { content: line, meta: true };
    return {
      marker: match[1] as DiffMarker,
      lineNumber: match[2].trim(),
      content: match[3].replace(/\t/g, "   "),
    };
  });
}

function errorRows(error: string): PreviewRow[] {
  return normalizeText(error).split("\n").filter(Boolean).map((content) => ({ content, meta: true }));
}

function boundRows(rows: readonly PreviewRow[], limit: number): { rows: PreviewRow[]; hidden: number } {
  if (rows.length <= limit) return { rows: [...rows], hidden: 0 };

  const changed = rows
    .map((row, index) => row.marker === "+" || row.marker === "-" ? index : -1)
    .filter((index) => index >= 0);
  if (changed.length === 0) return boundHeadAndTail(rows, limit);

  // Preserve changed lines across distant hunks before spending rows on context.
  // If the change set itself is larger than the card, sample both ends rather
  // than allowing the first hunk to crowd every later hunk out of view.
  let selected = new Set(changed);
  let materialized = materializeSelection(rows, selected);
  for (let count = Math.min(changed.length, limit); materialized.rows.length > limit && count > 0; count--) {
    selected = new Set(sampleBalanced(changed, count));
    materialized = materializeSelection(rows, selected);
  }

  const distances = distancesFromChanges(rows.length, changed);
  const contextCandidates = rows
    .map((_row, index) => index)
    .filter((index) => !selected.has(index))
    .sort((left, right) => distances[left]! - distances[right]! || left - right);

  for (const index of contextCandidates) {
    const candidate = new Set(selected);
    candidate.add(index);
    const next = materializeSelection(rows, candidate);
    if (next.rows.length <= limit) {
      selected = candidate;
      materialized = next;
    }
  }
  return materialized;
}

function boundHeadAndTail(rows: readonly PreviewRow[], limit: number): { rows: PreviewRow[]; hidden: number } {
  const visible = Math.max(2, limit - 1);
  const head = Math.ceil(visible / 2);
  const tail = Math.floor(visible / 2);
  const hidden = rows.length - head - tail;
  return {
    rows: [
      ...rows.slice(0, head),
      { content: `⋮ ${hidden} rows hidden`, meta: true },
      ...rows.slice(rows.length - tail),
    ],
    hidden,
  };
}

function materializeSelection(
  rows: readonly PreviewRow[],
  selected: ReadonlySet<number>,
): { rows: PreviewRow[]; hidden: number } {
  const indexes = [...selected].sort((left, right) => left - right);
  if (indexes.length === 0) return { rows: [], hidden: rows.length };
  const output: PreviewRow[] = [];
  let previous = -1;
  for (const index of indexes) {
    const gap = index - previous - 1;
    if (gap > 0) output.push({ content: `⋮ ${gap} ${gap === 1 ? "row" : "rows"} hidden`, meta: true });
    output.push(rows[index]!);
    previous = index;
  }
  const trailing = rows.length - previous - 1;
  if (trailing > 0) output.push({ content: `⋮ ${trailing} ${trailing === 1 ? "row" : "rows"} hidden`, meta: true });
  return { rows: output, hidden: rows.length - indexes.length };
}

function sampleBalanced(indexes: readonly number[], count: number): number[] {
  if (count >= indexes.length) return [...indexes];
  if (count <= 1) return [indexes[0]!];
  const head = Math.ceil(count / 2);
  const tail = Math.floor(count / 2);
  return [...indexes.slice(0, head), ...indexes.slice(indexes.length - tail)];
}

function distancesFromChanges(length: number, changed: readonly number[]): number[] {
  const distances = Array<number>(length).fill(Number.POSITIVE_INFINITY);
  let previous = Number.NEGATIVE_INFINITY;
  let changedIndex = 0;
  for (let index = 0; index < length; index++) {
    if (changed[changedIndex] === index) {
      previous = index;
      changedIndex += 1;
    }
    distances[index] = index - previous;
  }
  let next = Number.POSITIVE_INFINITY;
  changedIndex = changed.length - 1;
  for (let index = length - 1; index >= 0; index--) {
    if (changed[changedIndex] === index) {
      next = index;
      changedIndex -= 1;
    }
    distances[index] = Math.min(distances[index]!, next - index);
  }
  return distances;
}

function colorizeRows(rows: readonly PreviewRow[], language: string | undefined, theme: Theme): string[] {
  if (rows.length === 0) return [];
  const sourceRows = rows.map((row) => row.meta ? "" : row.content);
  const syntax = language ? highlightCode(sourceRows.join("\n"), language) : [];
  const numberWidth = rows.reduce((width, row) => Math.max(width, row.lineNumber?.length ?? 0), 0);

  return rows.map((row, index) => {
    if (row.meta) return theme.fg("dim", row.content);
    const content = language
      ? syntax[index] ?? row.content
      : theme.fg(row.marker === "+" ? "toolDiffAdded" : row.marker === "-" ? "toolDiffRemoved" : "toolOutput", row.content);
    const number = numberWidth > 0
      ? theme.fg("dim", (row.lineNumber ?? "").padStart(numberWidth, " ")) + " "
      : "";
    const marker = row.marker === "+"
      ? theme.fg("toolDiffAdded", "+")
      : row.marker === "-"
        ? theme.fg("toolDiffRemoved", "-")
        : row.marker === " "
          ? theme.fg("toolDiffContext", "·")
          : theme.fg("borderMuted", "│");
    return `${number}${marker} ${content}`;
  });
}

function renderHeader(model: CardModel, width: number, theme: Theme): string {
  const verb = model.operation === "edit" ? "EDIT" : "WRITE";
  const status = model.status === "pending"
    ? theme.fg("warning", "●")
    : model.status === "error"
      ? theme.fg("error", "✕")
      : theme.fg("success", "✓");
  const label = [
    status,
    theme.fg("toolTitle", theme.bold(verb)),
    theme.fg("accent", model.path),
    renderStats(model, theme),
  ].filter(Boolean).join(" ");
  return framedBorder("top", label, width, theme);
}

function renderStats(model: CardModel, theme: Theme): string {
  if (model.operation === "write") {
    if (model.lines === 0 && model.bytes === 0) return "";
    return theme.fg("dim", `${model.lines} ${model.lines === 1 ? "line" : "lines"} · ${formatBytes(model.bytes)}`);
  }
  if (model.status === "success" && (model.additions > 0 || model.removals > 0)) {
    return `${theme.fg("success", `+${model.additions}`)} ${theme.fg("error", `-${model.removals}`)}`;
  }
  if (model.changes > 0) {
    return theme.fg("dim", `${model.changes} ${model.changes === 1 ? "change" : "changes"}`);
  }
  return "";
}

function renderFooter(model: CardModel, width: number, expanded: boolean, hidden: number, theme: Theme): string {
  const language = displayLanguage(model.language);
  const state = model.status === "pending"
    ? theme.fg("warning", "applying")
    : model.status === "error"
      ? theme.fg("error", "failed")
      : theme.fg("success", model.operation === "edit" ? "applied" : "written");
  const details = [state, language ? theme.fg("dim", language) : ""];
  if (hidden > 0) {
    details.push(theme.fg("dim", expanded ? `${hidden} hidden · bounded preview` : `${hidden} hidden`));
  }
  if (!expanded && model.rows.length > COLLAPSED_BODY_ROWS) {
    details.push(theme.fg("dim", "Ctrl+O expand"));
  }
  return framedBorder("bottom", details.filter(Boolean).join(" · "), width, theme);
}

function framedBorder(edge: "top" | "bottom", label: string, width: number, theme: Theme): string {
  const left = edge === "top" ? "╭─ " : "╰─ ";
  const right = edge === "top" ? "╮" : "╯";
  const available = Math.max(0, width - visibleWidth(left) - 2);
  const fitted = truncateToWidth(label, available, available >= 2 ? "…" : "");
  const fill = "─".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(fitted) - 2));
  return `${theme.fg("borderAccent", left)}${fitted}${theme.fg("borderAccent", ` ${fill}${right}`)}`;
}

function renderBodyLine(content: string, width: number, theme: Theme): string {
  const innerWidth = Math.max(0, width - 4);
  const fitted = truncateToWidth(content, innerWidth, innerWidth >= 2 ? "…" : "");
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
  return `${theme.fg("borderAccent", "│")} ${fitted}${padding} ${theme.fg("borderAccent", "│")}`;
}

function resultText(result: ToolResultLike | undefined): string {
  return result?.content
    ?.filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n") ?? "";
}

function compactError(error: string): string {
  return error.replace(/\s+/g, " ").trim();
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\t/g, "   ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function displayLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const names: Record<string, string> = {
    javascript: "JavaScript",
    typescript: "TypeScript",
    javascriptreact: "JavaScript JSX",
    typescriptreact: "TypeScript JSX",
    shellscript: "Shell",
    markdown: "Markdown",
    python: "Python",
    rust: "Rust",
    go: "Go",
    ruby: "Ruby",
    json: "JSON",
    yaml: "YAML",
  };
  return names[language] ?? language.charAt(0).toUpperCase() + language.slice(1);
}
