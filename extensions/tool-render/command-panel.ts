import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { expansionHint } from "../../lib/tool-ui.ts";
import { washLine } from "./diff.ts";

/** Margin, gutter and text width of the panel at a terminal width. */
function geometry(width: number) {
  const margin = width >= 8 ? 2 : 0;
  const gutterWidth = width >= 6 ? 2 : 0;
  const rightPadding = width >= 8 ? 1 : 0;
  return { margin, gutterWidth, inner: Math.max(1, width - margin - gutterWidth - rightPadding) };
}

/** A neutral, inset command surface. Its shade is independent of execution state. */
export function commandPanel(highlighted: string, width: number, theme: Theme, expanded: boolean, { limit: collapsed = 4, noun = "command" } = {}): string[] {
  if (width <= 0) return [];
  const { margin, gutterWidth, inner } = geometry(width);
  const gutter = gutterWidth ? theme.fg("border", "│ ") : "";
  // A double-width glyph cannot occupy one cell. Keep the native word wrapper
  // on a safe canvas, then cell-clip only for exceptionally tiny terminals.
  const wrapped = wrapTextWithAnsi(highlighted, Math.max(2, inner));
  const limit = expanded ? 128 : collapsed;
  const background = theme.getBgAnsi?.("toolPendingBg") ?? "";
  const rows = wrapped.slice(0, limit).map((line) => {
    const text = gutter + truncateToWidth(line, inner, "");
    return " ".repeat(margin) + washLine(background, text, visibleWidth(text), width - margin);
  });
  if (wrapped.length > limit) {
    const indent = " ".repeat(Math.min(margin + gutterWidth, Math.max(0, width - 1)));
    const omitted = wrapped.length - limit;
    const notice = theme.fg("muted", `… ${omitted} more ${noun} ${omitted === 1 ? "line" : "lines"} · ${expanded ? "preview limit" : expansionHint()}`);
    rows.push(indent + truncateToWidth(notice, width - indent.length, ""));
  }
  return rows;
}

/** A shell command laid out for the panel width, then highlighted. */
export function shellPanel(command: string, width: number, theme: Theme, expanded: boolean, highlight: (source: string) => string): string[] {
  if (width <= 0) return [];
  return commandPanel(highlight(formatShellCommand(command, Math.max(2, geometry(width).inner))), width, theme, expanded);
}

interface Token { text: string; operator?: boolean }

const OPERATORS = ["&&", "||", "|&", "|", ";"];

/**
 * Top-level words and chain operators of one line. Quotes, escapes, `$(…)`,
 * `{…}` and `[[…]]` stay whole; comments are plain words.
 */
function shellTokens(line: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let quote = "";
  let depth = 0;
  const flush = () => {
    if (word) tokens.push({ text: word });
    word = "";
  };
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote) {
      word += char;
      if (char === "\\" && quote !== "'") word += line[++index] ?? "";
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "\\") {
      word += char + (line[++index] ?? "");
      continue;
    } else if (char === "#" && !word && depth === 0) {
      tokens.push(...line.slice(index).split(/\s+/).filter(Boolean).map((text) => ({ text })));
      return tokens;
    } else if (char === "(" || char === "{" || line.startsWith("[[", index)) depth++;
    else if ((char === ")" || char === "}" || line.startsWith("]]", index)) && depth > 0) depth--;
    if (depth === 0 && !quote) {
      if (/\s/.test(char)) {
        flush();
        continue;
      }
      const operator = OPERATORS.find((candidate) => line.startsWith(candidate, index));
      // `;;` and `;&` end case branches; they are not command separators.
      if (operator && !(operator === ";" && /[;&]/.test(line[index + 1] ?? "")) && line[index - 1] !== ";") {
        flush();
        tokens.push({ text: operator, operator: true });
        index += operator.length - 1;
        continue;
      }
    }
    word += char;
  }
  flush();
  return tokens;
}

/** Wrap words greedily; continuation rows indent two spaces. */
function wrapWords(words: Token[], indent: string, width: number): string[] {
  const rows: Token[][] = [];
  let row: Token[] = [];
  for (const word of words) {
    const candidate = `${rows.length ? `${indent}  ` : indent}${[...row, word].map((token) => token.text).join(" ")}`;
    if (row.length && visibleWidth(candidate) > width) {
      rows.push(row);
      row = [];
    }
    row.push(word);
  }
  if (row.length) rows.push(row);
  // Never strand an operator on its own continuation row.
  const last = rows.at(-1);
  const previous = rows.at(-2);
  if (last?.length === 1 && last[0]!.operator && previous && previous.length > 1) last.unshift(previous.pop()!);
  return rows.map((tokens, index) => `${index ? `${indent}  ` : indent}${tokens.map((token) => token.text).join(" ")}`);
}

function formatShellLine(line: string, width: number): string[] {
  const indent = /^\s*/.exec(line)![0];
  const segments: Token[][] = [[]];
  for (const token of shellTokens(line.slice(indent.length))) {
    segments.at(-1)!.push(token);
    if (token.operator) segments.push([]);
  }
  const rows = segments.filter((segment) => segment.length).flatMap((segment) => wrapWords(segment, indent, width));
  // A lone operator row joins the next command when both fit.
  for (let index = 0; index < rows.length - 1; index++) {
    const operator = rows[index]!.trim();
    if (!OPERATORS.includes(operator)) continue;
    const merged = `${/^\s*/.exec(rows[index]!)![0]}${operator} ${rows[index + 1]!.trimStart()}`;
    if (visibleWidth(merged) > width) continue;
    rows.splice(index, 2, merged);
    index--;
  }
  return rows.length ? rows : [line];
}

/**
 * Display layout only: lines that fit, and heredoc bodies, keep their source
 * layout. Long lines break after top-level `&&`, `||`, `|` and `;`, then at
 * quote-aware word boundaries.
 */
export function formatShellCommand(command: string, width: number): string {
  const rows: string[] = [];
  let heredoc: string | undefined;
  for (const line of command.split("\n")) {
    if (heredoc !== undefined) {
      rows.push(line);
      if (line.trim() === heredoc) heredoc = undefined;
      continue;
    }
    rows.push(...(visibleWidth(line) <= width ? [line] : formatShellLine(line, width)));
    heredoc = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(line)?.[2];
  }
  return rows.join("\n");
}
