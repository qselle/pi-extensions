export const MAX_SEEDED_QUERY_CHARS = 160;

export type HistorySource = "input" | "message" | "bash";

export interface HistoryItem {
  text: string;
  source: HistorySource;
  recency: number;
}

export interface FuzzyMatch {
  score: number;
  positions: number[];
}

export interface RankedHistoryItem extends HistoryItem {
  display: string;
  score: number;
  positions: number[];
}

interface SessionLikeEntry {
  type?: unknown;
  message?: unknown;
}

/**
 * Build newest-first editor history from Pi's public active-branch entries and
 * inputs observed during the current process. Exact duplicates keep the newest
 * occurrence.
 */
export function extractHistory(
  entries: readonly unknown[],
  recentInputs: readonly string[] = [],
): HistoryItem[] {
  const collected: Array<{ text: string; source: HistorySource }> = [];

  for (let index = recentInputs.length - 1; index >= 0; index--) {
    const text = normalizeHistoryText(recentInputs[index]);
    if (text) collected.push({ text, source: "input" });
  }

  for (let index = entries.length - 1; index >= 0; index--) {
    const candidate = historyTextFromEntry(entries[index]);
    if (candidate) collected.push(candidate);
  }

  const seen = new Set<string>();
  const history: HistoryItem[] = [];
  for (const candidate of collected) {
    if (seen.has(candidate.text)) continue;
    seen.add(candidate.text);
    history.push({ ...candidate, recency: history.length });
  }
  return history;
}

export function historyTextFromEntry(entry: unknown): { text: string; source: "message" | "bash" } | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const sessionEntry = entry as SessionLikeEntry;
  if (sessionEntry.type !== "message" || !sessionEntry.message || typeof sessionEntry.message !== "object") {
    return undefined;
  }

  const message = sessionEntry.message as {
    role?: unknown;
    content?: unknown;
    command?: unknown;
    excludeFromContext?: unknown;
  };
  if (message.role === "user") {
    const text = normalizeHistoryText(messageContentText(message.content));
    return text ? { text, source: "message" } : undefined;
  }
  if (message.role === "bashExecution" && typeof message.command === "string") {
    const command = normalizeHistoryText(message.command);
    if (!command) return undefined;
    return {
      text: `${message.excludeFromContext === true ? "!!" : "!"}${command}`,
      source: "bash",
    };
  }
  return undefined;
}

export function messageContentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    )
    .map((part) => part.text)
    .join("\n");
  return text || undefined;
}

export function displayHistoryText(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Seed reverse search from a short single-line draft; preserve larger drafts on cancel without using them as expensive queries. */
export function initialHistoryQuery(editorText: string): string {
  const normalized = editorText.replace(/\r\n?/g, "\n");
  if (normalized.includes("\n") || Array.from(normalized).length > MAX_SEEDED_QUERY_CHARS) return "";
  return normalized;
}

/**
 * FZF-style subsequence matching with boundary, consecutive, substring, prefix,
 * and exact-match bonuses. Dynamic programming keeps ranking O(query × text).
 */
export function fuzzyMatch(text: string, rawQuery: string): FuzzyMatch | undefined {
  const query = rawQuery.trim();
  if (!query) return { score: 0, positions: [] };

  const textChars = Array.from(text);
  const queryChars = Array.from(query);
  if (queryChars.length > textChars.length) return undefined;

  const foldedText = textChars.map((char) => char.toLocaleLowerCase());
  const foldedQuery = queryChars.map((char) => char.toLocaleLowerCase());
  const length = textChars.length;
  const negative = Number.NEGATIVE_INFINITY;
  const parents = Array.from({ length: queryChars.length }, () => {
    const row = new Int32Array(length);
    row.fill(-2);
    return row;
  });

  let previous = new Float64Array(length);
  previous.fill(negative);
  for (let index = 0; index < length; index++) {
    if (foldedText[index] !== foldedQuery[0]) continue;
    previous[index] = characterScore(textChars, queryChars[0]!, index) - index * 0.45;
    parents[0]![index] = -1;
  }

  const gapPenalty = 0.8;
  const consecutiveBonus = 13;
  for (let queryIndex = 1; queryIndex < queryChars.length; queryIndex++) {
    const current = new Float64Array(length);
    current.fill(negative);
    let bestGeneral = negative;
    let bestGeneralIndex = -1;

    for (let textIndex = 0; textIndex < length; textIndex++) {
      const priorIndex = textIndex - 1;
      if (priorIndex >= 0 && Number.isFinite(previous[priorIndex]!)) {
        const generalValue = previous[priorIndex]! + gapPenalty * priorIndex;
        if (generalValue > bestGeneral) {
          bestGeneral = generalValue;
          bestGeneralIndex = priorIndex;
        }
      }
      if (foldedText[textIndex] !== foldedQuery[queryIndex]) continue;

      let transition = negative;
      let parent = -2;
      if (bestGeneralIndex >= 0) {
        transition = bestGeneral - gapPenalty * (textIndex - 1);
        parent = bestGeneralIndex;
      }
      if (priorIndex >= 0 && Number.isFinite(previous[priorIndex]!)) {
        const consecutive = previous[priorIndex]! + consecutiveBonus;
        if (consecutive >= transition) {
          transition = consecutive;
          parent = priorIndex;
        }
      }
      if (!Number.isFinite(transition)) continue;

      current[textIndex] = transition + characterScore(textChars, queryChars[queryIndex]!, textIndex);
      parents[queryIndex]![textIndex] = parent;
    }
    previous = current;
  }

  let bestScore = negative;
  let bestEnd = -1;
  for (let index = 0; index < length; index++) {
    if (!Number.isFinite(previous[index]!)) continue;
    const score = previous[index]! - (length - index - 1) * 0.01 - length * 0.002;
    if (score > bestScore) {
      bestScore = score;
      bestEnd = index;
    }
  }
  if (bestEnd < 0) return undefined;

  const positions = new Array<number>(queryChars.length);
  let cursor = bestEnd;
  for (let queryIndex = queryChars.length - 1; queryIndex >= 0; queryIndex--) {
    positions[queryIndex] = cursor;
    cursor = parents[queryIndex]![cursor]!;
  }

  const foldedCandidate = foldedText.join("");
  const foldedNeedle = foldedQuery.join("");
  if (foldedCandidate === foldedNeedle) bestScore += 1_000;
  else if (foldedCandidate.startsWith(foldedNeedle)) bestScore += 180;
  else if (foldedCandidate.includes(foldedNeedle)) bestScore += 90;

  return { score: bestScore, positions };
}

export function rankHistory(items: readonly HistoryItem[], query: string): RankedHistoryItem[] {
  const ranked: RankedHistoryItem[] = [];
  for (const item of items) {
    const display = displayHistoryText(item.text);
    const match = fuzzyMatch(display, query);
    if (!match) continue;
    ranked.push({ ...item, display, score: match.score, positions: match.positions });
  }

  if (query.trim()) {
    ranked.sort((left, right) => right.score - left.score || left.recency - right.recency);
  } else {
    ranked.sort((left, right) => left.recency - right.recency);
  }
  return ranked;
}

function characterScore(text: readonly string[], queryChar: string, index: number): number {
  let score = 10;
  if (text[index] === queryChar) score += 1;
  if (index === 0) return score + 12;

  const previous = text[index - 1] ?? "";
  const current = text[index] ?? "";
  if (/\s|[\/_:.,\-]/u.test(previous)) score += 10;
  else if (/\p{Ll}/u.test(previous) && /\p{Lu}/u.test(current)) score += 8;
  return score;
}

function normalizeHistoryText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return normalized || undefined;
}
