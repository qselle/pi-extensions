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
  tail(limit = 2000): string {
    let start = Math.max(0, this.text.length - limit);
    if (isLow(this.text.charCodeAt(start))) start++;
    return this.text.slice(start);
  }
}
function isLow(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }
