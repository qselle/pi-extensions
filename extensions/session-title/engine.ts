/**
 * Pure titling logic shared by session titles and side-chat titles: provisional
 * local titles, prompt assembly, model-output normalization, refresh policy, and
 * cheap-model selection. No pi/tui imports, so it is fully unit-testable.
 */

export const MAX_TITLE_WORDS = 5;
export const MAX_TITLE_CHARS = 48;
/** User turns between refreshes; a title is otherwise left alone. */
export const DEFAULT_REFRESH_EVERY = 5;
const MAX_ANCHOR_CHARS = 600;
const MAX_RECENT_CHARS = 400;
const MAX_RECENT_TURNS = 6;
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
 * word- and char-capped. Returns undefined when the result is empty or generic.
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

/**
 * A free, instant title from the first prompt, used until the model answers.
 * Keeps meaningful words only, so "can you please fix the retry loop" becomes
 * "fix retry loop".
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

export interface TitleContext {
  /** First user prompt of the conversation: evidence of the original objective. */
  anchor?: string;
  /** Most recent user prompts, oldest first. */
  recent: string[];
  /** Title currently displayed, if any. */
  currentTitle?: string;
}

export const TITLE_SYSTEM_PROMPT = [
  "You name a coding conversation. Reply with the title only: no quotes, no punctuation at the end, no explanation.",
  `Use at most ${MAX_TITLE_WORDS} words and ${MAX_TITLE_CHARS} characters.`,
  "Name the durable objective, not the latest detail. A sub-task discussed for several turns stays subordinate.",
  "Prefer concrete nouns from the work itself over generic words like task, help, session, or code.",
  "When a current title is given and the objective has not changed, repeat that title exactly.",
  "Replace the current title when it is vague, truncated, a fragment, or does not describe the work in the requests below.",
].join("\n");

/**
 * Whether a title is worth showing the model as continuity evidence. A fragment
 * like "tig" would otherwise be repeated forever, since the model is asked to
 * preserve an unchanged objective.
 */
export function isCredibleTitle(title: string | undefined): boolean {
  const normalized = normalizeTitle(title);
  if (!normalized) return false;
  const words = normalized.split(" ").filter(Boolean);
  return words.length > 1 || normalized.length >= 8;
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

function clip(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

/**
 * Assembles the bounded user prompt. Only user text is included: never assistant
 * output, tool results, diffs, or reasoning, both to stay small and to keep the
 * titling request free of content the user never wrote.
 */
export function buildTitlePrompt(context: TitleContext): string {
  const parts: string[] = [];
  // A non-credible title is withheld so the model replaces it instead of echoing it.
  if (isCredibleTitle(context.currentTitle)) parts.push(`current_title: ${clip(context.currentTitle!, MAX_TITLE_CHARS)}`);
  if (context.anchor) parts.push(`first_request: ${clip(context.anchor, MAX_ANCHOR_CHARS)}`);

  const recent = context.recent.slice(-MAX_RECENT_TURNS).filter((text) => text.trim().length > 0);
  if (recent.length > 0) {
    parts.push("recent_requests:");
    for (const text of recent) parts.push(`- ${clip(text, MAX_RECENT_CHARS)}`);
  }
  parts.push("", "Title:");
  const prompt = parts.join("\n");
  return prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS)}\n\nTitle:` : prompt;
}

export interface RefreshState {
  /** User turns seen so far. */
  userTurns: number;
  /** userTurns value when the title was last generated, or undefined if never. */
  titledAtTurn?: number;
  /** Set once the user renames manually; auto-titling stops for good. */
  manual?: boolean;
}

/**
 * Titling is deliberately sparse: once after the first turn, then only every
 * `refreshEvery` user turns, and never after a manual rename.
 */
export function shouldGenerate(state: RefreshState, refreshEvery = DEFAULT_REFRESH_EVERY): boolean {
  if (state.manual) return false;
  if (state.userTurns < 1) return false;
  if (state.titledAtTurn === undefined) return true;
  return state.userTurns - state.titledAtTurn >= Math.max(1, refreshEvery);
}

/**
 * Picks the cheapest capable model for titling: an explicit override first, then
 * a small-model preference list, then the session model as a last resort.
 */
export function selectTitleModel<T>(
  find: (provider: string, id: string) => T | undefined,
  options: { override?: string; preferences?: readonly string[]; fallback?: T } = {},
): T | undefined {
  const candidates = options.override ? [options.override] : (options.preferences ?? DEFAULT_MODEL_PREFERENCES);
  for (const candidate of candidates) {
    const separator = candidate.indexOf("/");
    if (separator <= 0) continue;
    const found = find(candidate.slice(0, separator), candidate.slice(separator + 1));
    if (found) return found;
  }
  return options.override ? options.fallback : options.fallback;
}

/** Small, cheap, instruction-following models, best first. */
export const DEFAULT_MODEL_PREFERENCES: readonly string[] = [
  "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "anthropic/claude-haiku-4-5",
  "openai/gpt-4.1-mini",
  "google/gemini-2.5-flash",
  "amazon-bedrock/amazon.nova-lite-v1:0",
  "amazon-bedrock/amazon.nova-micro-v1:0",
];
