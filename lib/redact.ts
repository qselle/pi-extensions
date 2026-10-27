const REPLACEMENT = "[redacted]";

/** One alternation, longest first, so overlapping values redact the longer match. */
function compile(values: Iterable<string>): RegExp | undefined {
  const sorted = [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (sorted.length === 0) return undefined;
  return new RegExp(sorted.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
}

let cachedKey = "";
let cachedPattern: RegExp | undefined;
function patternFor(values: readonly string[]): RegExp | undefined {
  const key = values.join("\0");
  if (key !== cachedKey) { cachedKey = key; cachedPattern = compile(values); }
  return cachedPattern;
}

/** Holds possible secret prefixes until the next chunk, including overlapping values. */
export class StreamRedactor {
  private pending = "";
  private values = new Set<string>();
  private pattern?: RegExp;
  private longest = 0;
  private readonly secrets: () => readonly string[];
  constructor(secrets: () => readonly string[]) { this.secrets = secrets; }

  push(text: string, final = false): string {
    const known = this.values.size;
    for (const value of this.secrets()) if (value) this.values.add(value);
    if (this.values.size !== known) {
      this.pattern = compile(this.values);
      this.longest = Math.max(...[...this.values].map((value) => value.length));
    }
    this.pending += text;
    const end = final ? this.pending.length : this.safeEnd();
    const ready = this.pending.slice(0, end);
    const output = this.pattern ? ready.replace(this.pattern, REPLACEMENT) : ready;
    this.pending = this.pending.slice(end);
    if (final) { this.values.clear(); this.pattern = undefined; this.longest = 0; }
    return output;
  }

  /** Stop before a possible secret prefix, but never split a complete match. */
  private safeEnd(): number {
    const text = this.pending;
    if (!this.pattern) return text.length;
    let end = text.length;
    for (let start = Math.max(0, text.length - this.longest + 1); start < end; start++) {
      const suffix = text.slice(start);
      if ([...this.values].some((secret) => secret.length > suffix.length && secret.startsWith(suffix))) { end = start; break; }
    }
    for (const match of text.matchAll(this.pattern)) {
      if (match.index >= end) break;
      end = Math.max(end, match.index + match[0].length);
    }
    return end;
  }
}

export function redactText(text: string, values: readonly string[]): string {
  if (values.length === 0 || !text) return text;
  const pattern = patternFor(values);
  return pattern ? text.replace(pattern, REPLACEMENT) : text;
}

/** Redacts strings inside JSON-like values; unchanged inputs keep their identity. */
export function redactValue<T>(value: T, values: readonly string[]): T {
  if (values.length === 0) return value;
  if (typeof value === "string") return redactText(value, values) as T;
  if (Array.isArray(value)) {
    const next = value.map((item) => redactValue(item, values));
    return next.some((item, index) => item !== value[index]) ? next as T : value;
  }
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  let changed = false;
  const next = Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const redacted = redactValue(item, values);
    if (redacted !== item) changed = true;
    return [key, redacted];
  }));
  return changed ? next as T : value;
}
