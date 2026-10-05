/** Incremental terminal-control stripping, including escape sequences split across chunks. */
export class PlainOutput {
  private state: "text" | "escape" | "csi" | "string" | "stringEscape" = "text";
  private carriage = false;
  push(chunk: string): string {
    let out = "";
    for (const char of chunk) {
      if (this.state === "string") {
        if (char === "\x07" || char === "\x9c") this.state = "text";
        else if (char === "\x1b") this.state = "stringEscape";
      } else if (this.state === "stringEscape") {
        this.state = char === "\\" ? "text" : "string";
      } else if (this.state === "csi") {
        if (char >= "@" && char <= "~") this.state = "text";
      } else if (this.state === "escape") {
        if (char === "[") this.state = "csi";
        else if ("]P^_X".includes(char)) this.state = "string";
        else if (char >= "0" && char <= "~") this.state = "text";
      } else if (char === "\x1b") this.state = "escape";
      else if (char === "\x9b") this.state = "csi";
      else if (char === "\x9d" || char === "\x90") this.state = "string";
      else if (char === "\r") { out += "\n"; this.carriage = true; }
      else if (char === "\n") { if (!this.carriage) out += char; this.carriage = false; }
      else {
        this.carriage = false;
        if (char === "\t" || char >= " " && !(char >= "\x7f" && char <= "\x9f")) out += char;
      }
    }
    return out;
  }
}

export interface OutputSlice { text: string; cursor: number; lost: number; more: boolean }

/** A bounded read over retained output. `omitted` retained characters after `from` were skipped to fit the limit. */
export interface OutputWindow extends OutputSlice { from: number; omitted: number }

/**
 * Read retained `text`, which begins at absolute offset `start`, from `cursor`.
 * `newest` returns the last ≤limit characters ending at the output end; otherwise
 * pages forward from the cursor. Windows never split a surrogate pair.
 */
export function outputWindow(text: string, start: number, cursor: number, limit: number, newest: boolean): OutputWindow {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > start + text.length) throw new Error("Invalid output cursor.");
  if (!Number.isSafeInteger(limit) || limit < 2) throw new Error("Output limit must be at least two characters.");
  let begin = Math.max(cursor, start) - start;
  if (isLow(text.charCodeAt(begin))) begin++;
  let first = begin;
  let end = text.length;
  if (newest) {
    first = Math.max(begin, text.length - limit);
    if (isLow(text.charCodeAt(first))) first++;
  } else {
    end = Math.min(text.length, begin + limit);
    if (end < text.length && isLow(text.charCodeAt(end))) end--;
  }
  return { text: text.slice(first, end), cursor: start + end, lost: start + begin - cursor, more: end < text.length, from: start + begin, omitted: first - begin };
}

/** Bounded text with absolute UTF-16 cursors; reads never split a surrogate pair. */
export class OutputLog {
  private text = "";
  private offset = 0;
  readonly capacity: number;
  constructor(capacity = 64_000) {
    this.capacity = capacity;
    if (!Number.isSafeInteger(capacity) || capacity < 2) throw new Error("Log capacity must be at least two characters.");
  }
  get end(): number { return this.offset + this.text.length; }
  get start(): number { return this.offset; }
  append(text: string): void {
    this.text += text;
    let drop = Math.max(0, this.text.length - this.capacity);
    if (drop && isLow(this.text.charCodeAt(drop))) drop++;
    this.text = this.text.slice(drop);
    this.offset += drop;
  }
  read(cursor = this.offset, limit = 12_000): OutputSlice {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.end) throw new Error("Invalid output cursor.");
    if (!Number.isSafeInteger(limit) || limit < 2 || limit > 12_000) throw new Error("Output limit must be 2–12000 characters.");
    let start = Math.max(cursor, this.offset) - this.offset;
    if (isLow(this.text.charCodeAt(start))) start++;
    let end = Math.min(this.text.length, start + limit);
    if (end < this.text.length && isLow(this.text.charCodeAt(end))) end--;
    return { text: this.text.slice(start, end), cursor: this.offset + end, lost: this.offset + start - cursor, more: end < this.text.length };
  }
  /** Like `read`, with any limit up to the retained size and an optional newest-first window. */
  window(cursor = this.offset, limit = 24_000, newest = false): OutputWindow {
    return outputWindow(this.text, this.offset, cursor, limit, newest);
  }
  tail(limit = 2000): string {
    let start = Math.max(0, this.text.length - limit);
    if (isLow(this.text.charCodeAt(start))) start++;
    return this.text.slice(start);
  }
}
function isLow(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }
