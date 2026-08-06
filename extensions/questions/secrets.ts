import { randomBytes } from "node:crypto";

/**
 * Secret answers never enter the session transcript. The questionnaire tool
 * returns an opaque handle instead, and the extension swaps the handle for the
 * real value while a later tool call is executing. Values live only in memory
 * for the lifetime of the process branch that collected them.
 */

const HANDLE_ID_CHARS = 64;
const HANDLE_PATTERN = /\[\[secret:[A-Za-z0-9._-]{1,64}#[0-9a-f]{8}\]\]/g;

export const SECRET_HANDLE_HINT =
  "Secret answers are returned as handles. Copy a handle verbatim into later tool arguments; Pi substitutes the real value at execution time and keeps it out of the transcript.";

export function handleSlug(questionId: string): string {
  const slug = questionId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, HANDLE_ID_CHARS);
  return slug || "secret";
}

export function findSecretHandles(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.match(HANDLE_PATTERN) ?? []) found.add(match);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) findSecretHandles(item, found);
    return found;
  }
  if (isPlainRecord(value)) {
    for (const item of Object.values(value)) findSecretHandles(item, found);
  }
  return found;
}

export interface SecretRevealResult {
  /** Handles that were replaced with their stored value. */
  revealed: string[];
  /** Handles with no stored value; the caller should refuse the tool call. */
  unknown: string[];
}

export class SecretVault {
  private readonly values = new Map<string, string>();

  constructor(private readonly randomSuffix: () => string = defaultSuffix) {}

  get size(): number {
    return this.values.size;
  }

  has(handle: string): boolean {
    return this.values.has(handle);
  }

  /** Stores a secret answer and returns the handle that stands in for it. */
  issue(questionId: string, value: string): string {
    const slug = handleSlug(questionId);
    let handle = `[[secret:${slug}#${this.randomSuffix()}]]`;
    while (this.values.has(handle)) handle = `[[secret:${slug}#${this.randomSuffix()}]]`;
    this.values.set(handle, value);
    return handle;
  }

  /** Replaces known handles inside a tool input, mutating containers in place. */
  reveal(input: unknown): SecretRevealResult {
    const revealed = new Set<string>();
    const unknown = new Set<string>();
    this.substitute(input, revealed, unknown, (next) => next);
    return { revealed: [...revealed], unknown: [...unknown] };
  }

  clear(): void {
    this.values.clear();
  }

  private substitute(
    value: unknown,
    revealed: Set<string>,
    unknown: Set<string>,
    assign: (next: unknown) => void,
  ): void {
    if (typeof value === "string") {
      const substituted = value.replace(HANDLE_PATTERN, (handle) => {
        const secret = this.values.get(handle);
        if (secret === undefined) {
          unknown.add(handle);
          return handle;
        }
        revealed.add(handle);
        return secret;
      });
      if (substituted !== value) assign(substituted);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        this.substitute(item, revealed, unknown, (next) => { value[index] = next; });
      });
      return;
    }
    if (!isPlainRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
      this.substitute(item, revealed, unknown, (next) => { value[key] = next; });
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function defaultSuffix(): string {
  return randomBytes(4).toString("hex");
}
