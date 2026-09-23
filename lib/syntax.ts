import { createHighlighter, type BundledLanguage, type Highlighter } from "shiki";

const THEME = "gruvbox-dark-medium";
const LANGUAGES = [
  "typescript", "tsx", "javascript", "jsx", "bash", "python", "json", "jsonc",
  "yaml", "toml", "html", "css", "scss", "sql", "rust", "go", "c", "cpp", "zig",
  "markdown", "diff", "dockerfile", "makefile", "ruby", "java", "kotlin", "swift",
] satisfies BundledLanguage[];

export const SYNTAX_MAX_CODE_LENGTH = 64_000;
const MAX_LINE_LENGTH = 4_096;
const MAX_LINES = 2_000;
const MAX_CACHE_ENTRIES = 32;
const MAX_CACHE_CHARACTERS = 512_000;
// Foreground and font styles only: never clear the caller's diff/background wash.
const RESET = "\x1b[22;23;24;29;39m";
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const ALIASES: Record<string, string> = { sh: "bash", shell: "bash", zsh: "bash", golang: "go", "c++": "cpp", yml: "yaml" };

let highlighter: Highlighter | undefined;
let initialization: Promise<boolean> | undefined;
let generation = 0;
let supported = new Set<string>();
const cache = new Map<string, { lines: string[]; size: number }>();
let cachedCharacters = 0;

/** Initialize once per loaded extension lifetime; later highlighting is synchronous and local. */
export function initializeSyntax(): Promise<boolean> {
  if (initialization) return initialization;
  const initializingGeneration = generation;
  initialization = createHighlighter({ themes: [THEME], langs: LANGUAGES }).then((instance) => {
    if (initializingGeneration !== generation) {
      instance.dispose();
      return false;
    }
    try {
      // Grammar regexes compile lazily. Warm the large common grammars before a
      // render budget can interrupt their first real block halfway through a line.
      for (const lang of ["typescript", "tsx", "javascript", "jsx", "bash", "python"] as const) {
        instance.codeToTokens('const value = "hello"; // comment\nfunction hello() { return value; }\n', { lang, theme: THEME });
      }
      const languages = new Set(instance.getLoadedLanguages());
      highlighter = instance;
      supported = languages;
      return true;
    } catch {
      instance.dispose();
      return false;
    }
  }).catch(() => false);
  return initialization;
}

/** Release this extension's resources, including an initialization still in flight. */
export function disposeSyntax(): void {
  generation++;
  const instance = highlighter;
  highlighter = undefined;
  initialization = undefined;
  supported.clear();
  cache.clear();
  cachedCharacters = 0;
  try { instance?.dispose(); } catch { /* Cleanup must not interrupt session shutdown. */ }
}

/** Known, explicitly loaded grammars only; there is no content-based guessing. */
export function supportsSyntaxLanguage(language: string): boolean {
  const name = language.trim().toLowerCase();
  return supported.has(ALIASES[name] ?? name);
}

function foreground(color: string | undefined): string | undefined {
  if (!color || !/^#[\da-f]{6}$/i.test(color)) return;
  return `38;2;${Number.parseInt(color.slice(1, 3), 16)};${Number.parseInt(color.slice(3, 5), 16)};${Number.parseInt(color.slice(5, 7), 16)}`;
}

/**
 * Foreground-only terminal colors. Undefined asks the caller to keep its native
 * renderer. Source controls (including existing ANSI and CRLF) also take that path;
 * only generated SGR escapes enter a successful result. Stripping them recovers
 * the exact input, including tabs, empty lines and a trailing newline.
 */
export function highlightSyntax(code: string, language: string): string[] | undefined {
  if (!highlighter || code.length > SYNTAX_MAX_CODE_LENGTH || CONTROL.test(code)) return;
  const name = language.trim().toLowerCase();
  const lang = ALIASES[name] ?? name;
  if (!supported.has(lang)) return;
  const key = `${lang}\0${code}`;
  const found = cache.get(key);
  if (found) {
    cache.delete(key); cache.set(key, found);
    return found.lines.slice();
  }
  const source = code.split("\n");
  if (source.length > MAX_LINES || source.some((line) => line.length >= MAX_LINE_LENGTH)) return;
  try {
    const { tokens } = highlighter.codeToTokens(code, {
      lang: lang as BundledLanguage, theme: THEME, tokenizeMaxLineLength: MAX_LINE_LENGTH, tokenizeTimeLimit: 50,
    });
    if (tokens.length !== source.length) return;
    const lines: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const line = tokens[index]!;
      // A grammar/time limit must never cause displayed source to disappear.
      if (line.map((token) => token.content).join("") !== source[index]) return;
      let rendered = RESET;
      for (const token of line) {
        const codes: Array<string | number> = [];
        const color = foreground(token.color);
        if (color) codes.push(color);
        const style = token.fontStyle ?? 0;
        if (style & 1) codes.push(3);
        if (style & 2) codes.push(1);
        if (style & 4) codes.push(4);
        if (style & 8) codes.push(9);
        rendered += (codes.length ? `\x1b[${codes.join(";")}m` : "") + token.content + RESET;
      }
      lines.push(rendered);
    }
    const size = key.length + lines.reduce((total, line) => total + line.length, 0);
    if (size <= MAX_CACHE_CHARACTERS) {
      while (cache.size >= MAX_CACHE_ENTRIES || cachedCharacters + size > MAX_CACHE_CHARACTERS) {
        const oldest = cache.keys().next().value!;
        cachedCharacters -= cache.get(oldest)!.size;
        cache.delete(oldest);
      }
      cache.set(key, { lines, size }); cachedCharacters += size;
    }
    return lines.slice();
  } catch { return; }
}
