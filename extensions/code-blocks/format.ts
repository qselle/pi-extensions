import { PlainOutput } from "../../lib/output.ts";
import { Lexer } from "marked";

const ALIASES: Record<string, string> = { ts: "typescript", js: "javascript", py: "python", rb: "ruby", sh: "bash", shell: "bash", yml: "yaml", cs: "csharp", "c#": "csharp", "c++": "cpp", rs: "rust", golang: "go" };
export const MAX_MARKDOWN_LENGTH = 256_000;
export type CodeHighlighter = (code: string, language: string) => string[] | undefined;

function inlineLabel(value: string): string {
  // Captions cannot create links, emphasis, or terminal control sequences.
  const plain = new PlainOutput().push(value).replace(/\s+/g, " ").trim();
  const clipped = Array.from(plain).slice(0, 160).join("") + (Array.from(plain).length > 160 ? "…" : "");
  const runs = clipped.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  return `${fence} ${clipped} ${fence}`;
}

/** Split only the final closing fence; incomplete streamed bodies remain intact. */
function splitBody(raw: string, fence: string): { body: string; closing: string } {
  const end = raw.endsWith("\n") ? raw.length - 1 : raw.length;
  const lineStart = raw.lastIndexOf("\n", end - 1) + 1;
  const lastLine = raw.slice(lineStart, end);
  const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*$`);
  return closing.test(lastLine) ? { body: raw.slice(0, lineStart), closing: raw.slice(lineStart) } : { body: raw, closing: "" };
}

/** Display-only formatting. Parser raw spans protect prose and literal examples. */
export function formatCodeBlocks(markdown: string, languageFromPath: (path: string) => string | undefined, highlight?: CodeHighlighter): string {
  if (markdown.length > MAX_MARKDOWN_LENGTH || !/`{3}|~{3}/.test(markdown)) return markdown;
  try {
    const tokens = new Lexer().lex(markdown);
    // marked normalizes CRLF; never reconstruct a document unless raw spans are exact.
    if (tokens.map((token) => token.raw).join("") !== markdown) return markdown;
    return tokens.map((token) => {
      if (token.type !== "code" || token.codeBlockStyle === "indented") return token.raw;
      const match = /^( {0,3})(`{3,}|~{3,})([^\n]*)\n/.exec(token.raw);
      if (!match) return token.raw;
      const [, indent = "", fence = "", rawInfo = ""] = match;
      const info = rawInfo.trim();
      if (!info || info.length > 500) return token.raw;
      // A complete opening line fixes both language and caption, even while the
      // body is streaming. Rewriting only that line keeps literal code exact.
      const [first = "", ...rest] = info.split(/\s+/);
      let language = ALIASES[first.toLowerCase()] ?? first.toLowerCase();
      let caption = rest.join(" ");
      // A path-only fence can use Pi's public filename-to-language mapping.
      if (!rest.length && /[./\\]/.test(first)) {
        const inferred = languageFromPath(first);
        if (!inferred) return token.raw;
        language = inferred; caption = first;
      }
      if (!/^[a-z0-9_+-]{1,40}$/i.test(language)) return token.raw;
      // Empty-language fences let the native renderer preserve our ANSI instead
      // of parsing it as source with a second syntax engine. Keep the language
      // in a literal caption, and leave indentation-sensitive blocks to Pi.
      if (highlight && !indent) {
        const { body, closing } = splitBody(token.raw.slice(match[0].length), fence);
        const colored = highlight(body, language);
        if (colored) {
          // A final empty line may contain color resets. Keep those off the
          // closing fence so the second Markdown parse still recognizes it.
          const rendered = !body ? "" : body.endsWith("\n") ? `${colored.slice(0, -1).join("\n")}\n` : colored.join("\n");
          return `${inlineLabel(caption ? `${language} · ${caption}` : language)}\n\n${fence}\n${rendered}${closing}`;
        }
      }
      if (!caption && language === info) return token.raw;
      const header = `${indent}${fence}${language}\n`;
      return `${caption ? `${indent}${inlineLabel(caption)}\n\n` : ""}${header}${token.raw.slice(match[0].length)}`;
    }).join("");
  } catch { return markdown; }
}

/** Small LRU keyed by source, not session identity; no transcript copies grow without bound. */
export function createCodeBlockFormatter(languageFromPath: (path: string) => string | undefined, highlight?: CodeHighlighter) {
  const cache = new Map<string, { rendered: string; size: number }>();
  let characters = 0;
  return (markdown: string): string => {
    if (markdown.length > MAX_MARKDOWN_LENGTH) return markdown;
    const key = markdown;
    const found = cache.get(key);
    if (found) { cache.delete(key); cache.set(key, found); return found.rendered; }
    const rendered = formatCodeBlocks(markdown, languageFromPath, highlight);
    const size = key.length + rendered.length;
    if (size <= 512_000) {
      while (cache.size >= 8 || characters + size > 512_000) {
        const oldest = cache.keys().next().value!;
        characters -= cache.get(oldest)!.size;
        cache.delete(oldest);
      }
      cache.set(key, { rendered, size }); characters += size;
    }
    return rendered;
  };
}
