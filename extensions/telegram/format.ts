import { Lexer, type Token, type Tokens } from "marked";
import { PlainOutput } from "../../lib/output.ts";

const MAX_SOURCE_LENGTH = 16_384;
export const DIRECT_MESSAGE_LIMIT = 4_096;

export class TelegramMessageError extends Error {}

/** Render a bounded Markdown message using only Telegram's supported HTML tags. */
export function formatTelegramMessage(source: string): string {
  if (source.length > MAX_SOURCE_LENGTH) throw new TelegramMessageError("Telegram Markdown source must be at most 16384 characters.");
  const clean = new PlainOutput().push(source).trim();
  const html = render(new Lexer({ gfm: true, breaks: true }).lex(clean)).trim();
  const visible = html.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot);/g, "x");
  if (!visible.trim()) throw new TelegramMessageError("A Telegram message must contain text.");
  // UTF-16 is a conservative bound for supplementary Unicode characters.
  if (visible.length > DIRECT_MESSAGE_LIMIT) throw new TelegramMessageError("Telegram messages must fit 4096 characters after formatting; shorten the message.");
  return html;
}

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeHref(value: string): string | undefined {
  if (/[\x00-\x20\x7f-\x9f]/u.test(value)) return;
  try {
    const url = new URL(value);
    if (!["https:", "http:", "mailto:"].includes(url.protocol) || url.username || url.password) return;
    return escape(url.href);
  } catch { return; }
}

function render(tokens: readonly Token[], insideStyle = false, depth = 0): string {
  if (depth > 32) throw new TelegramMessageError("Telegram Markdown is nested too deeply; simplify the message.");
  return tokens.map((token): string => {
    const children = (styled = insideStyle) => render("tokens" in token ? token.tokens ?? [] : [], styled, depth + 1);
    switch (token.type) {
      case "space": return "";
      case "br": return "\n";
      case "def": return "";
      case "hr": return "─────\n\n";
      case "heading": return `<b>${children(true)}</b>\n\n`;
      case "paragraph": return `${children()}\n\n`;
      case "strong": return `<b>${children(true)}</b>`;
      case "em": return `<i>${children(true)}</i>`;
      case "del": return `<s>${children(true)}</s>`;
      case "codespan": return insideStyle ? escape(token.text) : `<code>${escape(token.text)}</code>`;
      case "code": {
        const language = (token.lang ?? "").split(/\s/u)[0];
        const code = escape(token.text);
        return /^[a-z0-9_+-]{1,40}$/iu.test(language)
          ? `<pre><code class="language-${language}">${code}</code></pre>\n\n`
          : `<pre>${code}</pre>\n\n`;
      }
      case "blockquote": return `${children().trim().replace(/^/gmu, "│ ")}\n\n`;
      case "list": return `${(token.items as Tokens.ListItem[]).map((item, index) => {
        const prefix = item.task ? (item.checked ? "☑" : "☐") : token.ordered ? `${Number(token.start) + index}.` : "•";
        return `${prefix} ${render(item.tokens, insideStyle, depth + 1).trim().replace(/\n/g, "\n  ")}`;
      }).join("\n")}\n\n`;
      case "table": return `<pre>${escape(token.raw.trim())}</pre>\n\n`;
      case "link": {
        const href = safeHref(token.href);
        // Code cannot be nested inside other Telegram entities.
        const label = children(true);
        return href ? `<a href="${href}">${label}</a>` : label;
      }
      case "image": return escape(token.text || "[image]");
      case "checkbox": return ""; // The list item's prefix already carries its task state.
      case "text": return token.tokens ? children() : escape(token.text);
      case "escape": return escape(token.text);
      default: return escape(token.raw);
    }
  }).join("");
}
