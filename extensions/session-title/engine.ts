/**
 * Pure titling logic: prompt signal detection, prompt assembly, and model-output
 * normalization. No pi/tui imports, so it is fully unit-testable.
 *
 * A conversation is titled once from its first meaningful request. Nothing
 * re-titles it automatically, so there is no refresh policy or stored state.
 */

export const MAX_TITLE_WORDS = 4;
export const MAX_TITLE_CHARS = 48;
const MAX_ANCHOR_CHARS = 600;
const MAX_RECENT_CHARS = 400;
const MAX_RECENT_TURNS = 5;
const MAX_PROMPT_CHARS = 4_000;

const GENERIC_TITLES = /^(?:untitled|new session|new side chat|session|chat|conversation|task|help|hello|hi|test)$/i;

/** Words too weak to carry a provisional title on their own. */
const FILLER = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "please",
  "at", "from", "into", "about", "by", "as", "so", "if", "then", "there", "here",
  "can", "you", "could", "would", "i", "we", "my", "our", "it", "this", "that", "is", "are",
  "do", "does", "did", "how", "what", "why", "when", "should", "let", "lets", "just", "now",
]);

/**
 * Normalizes a model-produced title: single line, no quotes or trailing period,
 * word- and char-capped. Returns undefined when the result is empty or generic,
 * so a bad answer leaves the existing name alone.
 */
export function normalizeTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let title = raw
    .split("\n")[0]!
    .replace(/^["'`*\s]+|["'`*\s]+$/g, "")
    .replace(/^(?:title|session|chat)\s*[:\-–]\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/, "")
    .trim();
  if (!title || GENERIC_TITLES.test(title)) return undefined;

  const words = title.split(" ").filter(Boolean);
  if (words.length > MAX_TITLE_WORDS) title = words.slice(0, MAX_TITLE_WORDS).join(" ");
  if (title.length > MAX_TITLE_CHARS) {
    title = `${[...title].slice(0, MAX_TITLE_CHARS - 1).join("").trimEnd()}…`;
  }
  return title || undefined;
}

/** Manual names preserve wording and punctuation rather than model-title rules. */
export function normalizeManualTitle(raw: string): string | undefined {
  const text = raw.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const characters = [...text];
  return characters.length > 120 ? `${characters.slice(0, 119).join("")}…` : text;
}

/** Enforce the noun-phrase contract on model output even if it echoes a task verb. */
export function normalizeGeneratedTitle(raw: unknown): string | undefined {
  const normalized = normalizeTitle(raw);
  if (!normalized) return undefined;
  return normalizeTitle(normalized.replace(
    /^(?:add|build|change|create|debug|design|explain|fix|implement|improve|investigate|migrate|optimize|refactor|remove|rename|review|update)\s+/i,
    "",
  ));
}

/**
 * A compact local label used by side chats and to detect whether a main-session
 * prompt carries enough signal to title. Main sessions never display this
 * heuristic text.
 */
export function provisionalTitle(prompt: string, maxWords = 4): string | undefined {
  const cleaned = prompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s/._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;

  const words = cleaned.split(" ");
  const meaningful = words.filter((word) => word.length > 1 && !FILLER.has(word.toLowerCase()));
  const chosen = (meaningful.length > 0 ? meaningful : words).slice(0, maxWords);
  return normalizeTitle(chosen.join(" "));
}

/**
 * The first request that actually says something. Sessions often open with
 * "hello", which is worthless as evidence of the objective.
 */
export function pickAnchor(texts: readonly string[]): string | undefined {
  for (const text of texts) {
    if (provisionalTitle(text)) return text;
  }
  return texts[0];
}

export const TITLE_SYSTEM_PROMPT = [
  "Name this coding conversation from the user's request.",
  "Reply only with a specific noun phrase in title case: no quotes, punctuation, or explanation.",
  `Use 2–${MAX_TITLE_WORDS} words and at most ${MAX_TITLE_CHARS} characters.`,
  "Describe the subject, not the requested action. Do not begin with a task verb such as Add, Fix, Update, Implement, Create, Improve, or Investigate.",
  "Prefer concrete product, component, or problem names over generic words such as task, help, session, chat, or code.",
].join("\n");

function clip(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

/**
 * Assembles the bounded prompt from user text only: never assistant output, tool
 * results, diffs, or reasoning.
 */
export function buildTitlePrompt(userTexts: readonly string[]): string {
  const anchor = pickAnchor(userTexts);
  const parts: string[] = [];
  if (anchor) parts.push(`first_request: ${clip(anchor, MAX_ANCHOR_CHARS)}`);

  const recent = userTexts.filter((text) => text !== anchor && text.trim()).slice(-MAX_RECENT_TURNS);
  if (recent.length > 0) {
    parts.push("recent_requests:");
    for (const text of recent) parts.push(`- ${clip(text, MAX_RECENT_CHARS)}`);
  }
  parts.push("", "Title:");
  const prompt = parts.join("\n");
  return prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS)}\n\nTitle:` : prompt;
}
