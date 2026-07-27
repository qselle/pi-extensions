import { isAbsolute, resolve } from "node:path";

/** OSC 8 opener/closer, using the ST terminator (`ESC \`) which is the safest form. */
const OSC8_OPEN = "\x1b]8;;";
const OSC8_ST = "\x1b\\";
export const OSC8_CLOSE = `${OSC8_OPEN}${OSC8_ST}`;

export type HyperlinkMode = "auto" | "always" | "never";

let mode: HyperlinkMode = "auto";

export function setHyperlinkMode(next: HyperlinkMode): void {
  mode = next;
}

export function getHyperlinkMode(): HyperlinkMode {
  return mode;
}

export interface TerminalEnvironment {
  TERM_PROGRAM?: string;
  TERM?: string;
  FORCE_HYPERLINK?: string;
  NO_HYPERLINK?: string;
}

/**
 * Terminals that render OSC 8. Apple Terminal parses the sequence but shows the
 * URL as literal text, so it is excluded.
 */
export function supportsHyperlinks(
  env: TerminalEnvironment = process.env as TerminalEnvironment,
  isTty: boolean = Boolean(process.stdout?.isTTY),
): boolean {
  if (env.NO_HYPERLINK) return false;
  if (env.FORCE_HYPERLINK) return true;
  if (!isTty) return false;
  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb" || !term) return false;
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (program === "apple_terminal") return false;
  return true;
}

export function hyperlinksEnabled(
  env: TerminalEnvironment = process.env as TerminalEnvironment,
  isTty: boolean = Boolean(process.stdout?.isTTY),
): boolean {
  if (mode === "never") return false;
  if (mode === "always") return true;
  return supportsHyperlinks(env, isTty);
}

/** Builds a `file://` URI, percent-encoding but preserving path separators. */
export function fileUri(absPath: string): string {
  return `file://${encodeURI(absPath.replace(/\\/g, "/"))}`;
}

export function toAbsolutePath(path: string, cwd: string = process.cwd()): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * Detects an absolute URI scheme. Requires `//` for generic schemes so Windows
 * drive letters (`C:\src`) are not mistaken for one, with an allowlist for
 * common schemes that have no authority component.
 */
export function hasUriScheme(value: string): boolean {
  return /^(?:https?|mailto|ftp|ssh|vscode|cursor|zed):/i.test(value)
    || /^[a-z][a-z0-9+.-]+:\/\//i.test(value);
}

/** Wraps display text in a link to any URI, ignoring path resolution. */
export function hyperlinkUrl(display: string, url: string): string {
  if (!display || !hyperlinksEnabled()) return display;
  return link(display, url);
}

/**
 * Wraps `display` in an OSC 8 hyperlink to `path` without changing its visible
 * width. Returns `display` unchanged when hyperlinks are unavailable.
 *
 * Accepts an absolute URI too, which is passed through instead of being resolved
 * against `cwd`.
 */
export function hyperlinkPath(display: string, path: string, cwd?: string): string {
  if (!display || !hyperlinksEnabled()) return display;
  if (hasUriScheme(path)) return link(display, path);
  return link(display, fileUri(toAbsolutePath(path, cwd)));
}

export function link(display: string, uri: string): string {
  return `${OSC8_OPEN}${uri}${OSC8_ST}${display}${OSC8_CLOSE}`;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Counts real openers vs closers. A closer contains an opener as a prefix, so
 * `count(OPEN) - count(CLOSE)` is the number of links actually opened.
 */
function linkBalance(text: string): { opened: number; closed: number } {
  const closed = countOccurrences(text, OSC8_CLOSE);
  const opened = countOccurrences(text, OSC8_OPEN) - closed;
  return { opened, closed };
}

/** True when the string opens more hyperlinks than it closes. */
export function hasDanglingLink(text: string): boolean {
  const { opened, closed } = linkBalance(stripPartialEscape(text));
  return opened > closed;
}

/**
 * Repairs a line that was truncated mid-hyperlink.
 *
 * Width-aware truncation keeps the opening OSC 8 sequence (it has zero visible
 * width) but drops the closing one, which makes every following line part of the
 * link. This appends the missing terminator, and strips a trailing partial
 * escape if truncation landed inside one.
 */
export function closeDanglingLink(text: string): string {
  if (!text.includes(OSC8_OPEN)) return text;
  const cleaned = stripPartialEscape(text);
  const { opened, closed } = linkBalance(cleaned);
  return opened > closed ? `${cleaned}${OSC8_CLOSE}` : cleaned;
}

/** Removes a dangling `ESC ]8;;…` fragment with no terminator at the very end. */
function stripPartialEscape(text: string): string {
  const lastOpen = text.lastIndexOf(OSC8_OPEN);
  if (lastOpen < 0) return text;
  const tail = text.slice(lastOpen + OSC8_OPEN.length);
  // A complete opener is followed by its ST terminator somewhere in the tail.
  if (tail.includes(OSC8_ST) || tail.includes("\x07")) return text;
  return text.slice(0, lastOpen);
}
