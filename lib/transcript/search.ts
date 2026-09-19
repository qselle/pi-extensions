import { plainText } from "./model.ts";

export interface SearchMatch { firstLine: number; lastLine: number }
interface Span { start: number; end: number; line: number }
interface Passage { text: string; spans: Span[] }

const normalize = (text: string) => plainText(text).toLocaleLowerCase().replace(/\s+/gu, " ").trim();
const compact = (text: string) => text.replace(/\s/gu, "");

/** Match logical text, then project its offsets onto the native renderer's rows.
 * A failed projection falls back to row searches rather than guessing at content.
 */
export class TranscriptSearch {
  private readonly passages: Passage[];

  constructor(private readonly rows: readonly string[], logicalLines: readonly string[], private readonly markdown = false) {
    // Native Markdown repeats its quote border on every wrapped row.
    const clean = (line: string) => normalize(markdown ? plainText(line).replace(/^(?:│ ?)+/u, "") : line);
    const display = rows.map(clean);
    const logical = logicalLines.map(clean);
    const projected: Passage[] = [];
    let row = 0;
    let valid = true;
    for (const text of logical) {
      if (!text) continue;
      const source = compact(text);
      let offset = 0;
      const spans: Span[] = [];
      while (offset < source.length) {
        while (row < display.length && !display[row]) row++;
        const part = compact(display[row] ?? "");
        if (!part || !source.startsWith(part, offset)) { valid = false; break; }
        spans.push({ start: offset, end: offset + part.length, line: row++ });
        offset += part.length;
      }
      if (!valid) break;
      projected.push({ text, spans });
    }
    if (display.slice(row).some(Boolean)) valid = false;
    this.passages = valid ? projected : rows.map((text, line) => {
      const normalized = normalize(text);
      return { text: normalized, spans: [{ start: 0, end: compact(normalized).length, line }] };
    });
  }

  find(query: string): SearchMatch[] {
    const needle = normalize(query);
    if (!needle) return [];
    // A literal border character may also be content. Keep it searchable without
    // treating generated quote borders as characters inside ordinary phrases.
    if (this.markdown && needle.includes("│")) return new TranscriptSearch(this.rows, this.rows).find(query);
    const needleLength = compact(needle).length;
    const matches: SearchMatch[] = [];
    for (const { text, spans } of this.passages) {
      let scanned = 0;
      let compactOffset = 0;
      let spanIndex = 0;
      for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, scanned)) {
        compactOffset += compact(text.slice(scanned, start)).length;
        const end = compactOffset + needleLength;
        while (spanIndex < spans.length && spans[spanIndex]!.end <= compactOffset) spanIndex++;
        let last = spanIndex;
        while (last + 1 < spans.length && spans[last]!.end < end) last++;
        if (spans[spanIndex] && spans[last]) matches.push({ firstLine: spans[spanIndex]!.line, lastLine: spans[last]!.line });
        scanned = start + needle.length;
        compactOffset = end;
      }
    }
    return matches;
  }
}
