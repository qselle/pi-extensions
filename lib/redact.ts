/** Holds possible secret prefixes until the next chunk, including overlapping values. */
export class StreamRedactor {
  private pending = "";
  private values = new Set<string>();
  private readonly secrets: () => readonly string[];
  constructor(secrets: () => readonly string[]) { this.secrets = secrets; }
  push(text: string, final = false): string {
    for (const value of this.secrets()) if (value) this.values.add(value);
    this.pending += text;
    const secrets = [...this.values].sort((a, b) => b.length - a.length);
    let output = "";
    let index = 0;
    while (index < this.pending.length) {
      const remaining = this.pending.length - index;
      if (!final && secrets.some((secret) => secret.length > remaining && secret.startsWith(this.pending.slice(index)))) break;
      const match = secrets.find((secret) => this.pending.startsWith(secret, index));
      if (match) { output += "[redacted]"; index += match.length; }
      else { output += this.pending[index]; index++; }
    }
    this.pending = this.pending.slice(index);
    if (final) this.values.clear();
    return output;
  }
}

export function redactText(text: string, values: readonly string[]): string {
  return new StreamRedactor(() => values).push(text, true);
}
