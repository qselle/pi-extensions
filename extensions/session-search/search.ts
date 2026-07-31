import { createReadStream, existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

export const MAX_QUERY_CHARS = 300;
export const MAX_QUERY_TERMS = 32;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_LINE_CHARS = 1024 * 1024;
export const MAX_RESULTS = 100;
export const SEARCH_CONCURRENCY = 6;
export const MAX_SNIPPET_CHARS = 360;

export type SessionSearchScope = "all" | "current";

export interface ParsedSessionSearchArgs {
  query: string;
  scope: SessionSearchScope;
}

export interface SessionSearchResult {
  session: SessionInfo;
  score: number;
  snippet: string;
  entryId?: string;
  entryLabel: string;
  truncated: boolean;
  malformedLines: number;
  oversizedLines: number;
}

export interface SessionScanOutcome {
  result?: SessionSearchResult;
  unreadable: boolean;
  truncated: boolean;
  malformedLines: number;
  oversizedLines: number;
}

export interface SessionSearchSummary {
  results: SessionSearchResult[];
  scannedSessions: number;
  unreadableSessions: number;
  truncatedSessions: number;
  malformedLines: number;
  oversizedLines: number;
}

export interface SessionScanOptions {
  maxFileBytes?: number;
  maxLineChars?: number;
}

export interface SearchSessionsOptions extends SessionScanOptions {
  concurrency?: number;
  maxResults?: number;
  onProgress?: (completed: number, total: number) => void;
}

export interface CurrentProjectSelection {
  sessions: SessionInfo[];
  projectRoot: string;
  kind: "git" | "cwd";
}

interface SearchFragment {
  text: string;
  label: string;
  entryId?: string;
  weight?: number;
}

interface RankedFragment extends SearchFragment {
  score: number;
  matchedTermCount: number;
}

interface BoundedLineReadResult {
  truncated: boolean;
  malformedLines: number;
  oversizedLines: number;
}

export function parseSessionSearchArgs(args: string): ParsedSessionSearchArgs {
  const tokens = tokenizeCommandArgs(args.trim());
  let scope: SessionSearchScope = "all";
  let flagsEnded = false;
  const query: string[] = [];

  for (const token of tokens) {
    if (!flagsEnded && token === "--") {
      flagsEnded = true;
      continue;
    }
    if (!flagsEnded && (token === "--current" || token === "--project")) {
      scope = "current";
      continue;
    }
    if (!flagsEnded && token === "--all") {
      scope = "all";
      continue;
    }
    if (!flagsEnded && token.startsWith("--")) {
      throw new Error(`Unknown session-search option: ${token}. Use --current, --all, or -- before a literal option.`);
    }
    query.push(token);
  }

  const text = query.join(" ").trim();
  if (Array.from(text).length > MAX_QUERY_CHARS) {
    throw new Error(`Session-search query must be at most ${MAX_QUERY_CHARS} characters.`);
  }
  if (queryTerms(text).length > MAX_QUERY_TERMS) {
    throw new Error(`Session-search query must contain at most ${MAX_QUERY_TERMS} distinct terms.`);
  }
  return { query: text, scope };
}

export function scoreSearchText(text: string, query: string): { score: number; matchedTerms: Set<string> } {
  const haystack = normalize(text);
  const phrase = normalize(query.trim());
  const terms = queryTerms(query);
  const matchedTerms = new Set<string>();
  let score = Math.min(3, countOccurrences(haystack, phrase)) * 30;

  for (const term of terms) {
    const count = countOccurrences(haystack, term);
    if (count === 0) continue;
    matchedTerms.add(term);
    score += 6 + Math.min(4, count - 1);
  }

  if (matchedTerms.size === terms.length && terms.length > 1) score += 8;
  return { score, matchedTerms };
}

export async function scanSession(
  session: SessionInfo,
  query: string,
  options: SessionScanOptions = {},
): Promise<SessionScanOutcome> {
  const terms = queryTerms(query);
  if (terms.length === 0) throw new Error("Session-search query cannot be empty.");

  const foundTerms = new Set<string>();
  let totalScore = 0;
  let best: RankedFragment | undefined;
  const consider = (fragment: SearchFragment) => {
    const ranked = scoreSearchText(fragment.text, query);
    if (ranked.score <= 0) return;
    for (const term of ranked.matchedTerms) foundTerms.add(term);
    const weightedScore = ranked.score * (fragment.weight ?? 1);
    const matchedTermCount = ranked.matchedTerms.size;
    totalScore = Math.min(10_000, totalScore + Math.min(160, weightedScore));
    if (!best || matchedTermCount > best.matchedTermCount
      || (matchedTermCount === best.matchedTermCount && weightedScore > best.score)) {
      best = { ...fragment, score: weightedScore, matchedTermCount };
    }
  };

  for (const fragment of metadataFragments(session)) consider(fragment);

  let unreadable = false;
  let readResult: BoundedLineReadResult = { truncated: false, malformedLines: 0, oversizedLines: 0 };
  try {
    readResult = await readBoundedJsonLines(
      session.path,
      options.maxFileBytes ?? MAX_FILE_BYTES,
      options.maxLineChars ?? MAX_LINE_CHARS,
      (entry) => {
        for (const fragment of entryFragments(entry)) consider(fragment);
      },
    );
  } catch {
    unreadable = true;
  }

  let result: SessionSearchResult | undefined;
  if (best && terms.every((term) => foundTerms.has(term))) {
    result = {
      session,
      score: totalScore,
      snippet: snippetAround(best.text, query),
      entryId: best.entryId,
      entryLabel: best.label,
      truncated: readResult.truncated,
      malformedLines: readResult.malformedLines,
      oversizedLines: readResult.oversizedLines,
    };
  }
  return {
    result,
    unreadable,
    truncated: readResult.truncated,
    malformedLines: readResult.malformedLines,
    oversizedLines: readResult.oversizedLines,
  };
}

export async function searchSessions(
  sessions: readonly SessionInfo[],
  query: string,
  options: SearchSessionsOptions = {},
): Promise<SessionSearchSummary> {
  const outcomes = await mapConcurrent(
    sessions,
    options.concurrency ?? SEARCH_CONCURRENCY,
    async (session, index) => {
      const outcome = await scanSession(session, query, options);
      options.onProgress?.(index.completed(), sessions.length);
      return outcome;
    },
  );

  return {
    results: outcomes
      .flatMap((outcome) => outcome.result ? [outcome.result] : [])
      .sort((left, right) => right.score - left.score
        || right.session.modified.getTime() - left.session.modified.getTime()
        || left.session.id.localeCompare(right.session.id))
      .slice(0, clamp(options.maxResults ?? MAX_RESULTS, 1, MAX_RESULTS)),
    scannedSessions: outcomes.length,
    unreadableSessions: outcomes.filter((outcome) => outcome.unreadable).length,
    truncatedSessions: outcomes.filter((outcome) => outcome.truncated).length,
    malformedLines: outcomes.reduce((sum, outcome) => sum + outcome.malformedLines, 0),
    oversizedLines: outcomes.reduce((sum, outcome) => sum + outcome.oversizedLines, 0),
  };
}

export function selectCurrentProjectSessions(
  sessions: readonly SessionInfo[],
  cwd: string,
): CurrentProjectSelection {
  const canonicalCwd = canonicalPath(cwd);
  const gitRoot = findGitRoot(canonicalCwd);
  const projectRoot = gitRoot ?? canonicalCwd;
  const kind: CurrentProjectSelection["kind"] = gitRoot ? "git" : "cwd";
  const selected = sessions.filter((session) => {
    if (!session.cwd) return false;
    const sessionCwd = canonicalPath(session.cwd);
    if (kind === "cwd") return sessionCwd === projectRoot;
    const sessionRoot = findGitRoot(sessionCwd);
    if (sessionRoot) return sessionRoot === projectRoot;
    return pathIsWithin(projectRoot, sessionCwd);
  });
  return { sessions: selected, projectRoot, kind };
}

export function resultLabel(result: SessionSearchResult, rank: number, home = process.env.HOME ?? ""): string {
  const date = validDate(result.session.modified).toISOString().slice(0, 10);
  const title = compactText(result.session.name || result.session.firstMessage || result.session.id, 64);
  const location = compactText(compactPath(result.session.cwd || "(unknown cwd)", home), 38);
  return `${rank + 1}. ${date} · ${title} · ${location} · ${result.session.id.slice(0, 8)}`;
}

export function resultDetails(result: SessionSearchResult, home = process.env.HOME ?? ""): string {
  const warnings: string[] = [];
  if (result.truncated) warnings.push("file scan capped");
  if (result.oversizedLines > 0) warnings.push(`${result.oversizedLines} oversized line${result.oversizedLines === 1 ? "" : "s"} skipped`);
  if (result.malformedLines > 0) warnings.push(`${result.malformedLines} malformed line${result.malformedLines === 1 ? "" : "s"} skipped`);
  return [
    result.session.name ? `Title: ${sanitizeDisplayText(result.session.name)}` : undefined,
    `Session: ${sanitizeDisplayText(result.session.id)}`,
    `Project: ${compactPath(result.session.cwd || "(unknown cwd)", home)}`,
    `Modified: ${validDate(result.session.modified).toLocaleString()}`,
    `Match: ${result.entryLabel}${warnings.length > 0 ? ` · ${warnings.join(" · ")}` : ""}`,
    "",
    result.snippet,
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function compactPath(path: string, home = process.env.HOME ?? ""): string {
  const clean = sanitizeDisplayText(path);
  return home && (clean === home || clean.startsWith(`${home}/`)) ? `~${clean.slice(home.length)}` : clean;
}

export function compactText(text: string, limit: number): string {
  const normalized = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  const chars = Array.from(normalized);
  return chars.length <= limit ? normalized : `${chars.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

export function sanitizeDisplayText(text: string): string {
  return String(text)
    .replace(/<!-- pi:web-search(?:-(?:query(?:-count)?|source(?:-count)?))?:[^>]* -->/gi, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function metadataFragments(session: SessionInfo): SearchFragment[] {
  return [
    { text: session.name ?? "", label: "session title", weight: 4 },
    { text: session.firstMessage ?? "", label: "first user message", weight: 2 },
    { text: session.cwd ?? "", label: "working directory" },
    { text: session.id ?? "", label: "session id" },
  ];
}

function entryFragments(value: unknown): SearchFragment[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const entry = value as Record<string, unknown>;
  const entryId = typeof entry.id === "string" ? entry.id : undefined;
  if (entry.type === "session") {
    return [{ text: `${stringValue(entry.id)}\n${stringValue(entry.cwd)}`, label: "session header" }];
  }
  if (entry.type === "session_info") {
    return [{ text: stringValue(entry.name), label: "session title", entryId, weight: 4 }];
  }
  if (entry.type === "compaction") {
    return [{ text: stringValue(entry.summary), label: "compaction summary", entryId, weight: 2 }];
  }
  if (entry.type === "branch_summary") {
    return [{ text: stringValue(entry.summary), label: "branch summary", entryId, weight: 2 }];
  }
  if (entry.type === "label") {
    return [{ text: stringValue(entry.label), label: "entry label", entryId }];
  }
  if (entry.type === "model_change") {
    return [{ text: `${stringValue(entry.provider)} ${stringValue(entry.modelId)}`, label: "model change", entryId }];
  }
  if (entry.type === "custom_message") {
    return [{ text: contentText(entry.content), label: `custom message ${stringValue(entry.customType)}`.trim(), entryId }];
  }
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return [];

  const message = entry.message as Record<string, unknown>;
  const role = stringValue(message.role) || "message";
  const fragments: SearchFragment[] = [];
  const text = contentText(message.content);
  if (text) {
    fragments.push({
      text,
      label: role === "toolResult" ? `${stringValue(message.toolName) || "tool"} result` : `${role} message`,
      entryId,
      weight: role === "user" ? 2 : 1,
    });
  }
  if (typeof message.command === "string") fragments.push({ text: message.command, label: "shell command", entryId, weight: 2 });
  if (typeof message.errorMessage === "string") fragments.push({ text: message.errorMessage, label: "assistant error", entryId, weight: 2 });
  if (role === "toolResult" && typeof message.toolName === "string") {
    fragments.push({ text: message.toolName, label: `${message.toolName} result`, entryId });
  }
  return fragments;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return sanitizeDisplayText(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const part = item as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") parts.push(sanitizeDisplayText(part.text));
    if (part.type === "toolCall") {
      const name = typeof part.name === "string" ? part.name : "tool";
      parts.push(`${name} ${safeJson(part.arguments)}`.trim());
    }
    // Deliberately exclude model thinking and image data: they add noise and may
    // contain content the user did not intend to recover through full-text search.
  }
  return parts.join("\n");
}

async function readBoundedJsonLines(
  path: string,
  maxFileBytes: number,
  maxLineChars: number,
  onEntry: (entry: unknown) => void,
): Promise<BoundedLineReadResult> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let consumedBytes = 0;
  let pending = "";
  let droppingOversizedLine = false;
  let truncated = false;
  let malformedLines = 0;
  let oversizedLines = 0;

  const processLine = (line: string) => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!trimmed.trim()) return;
    try {
      onEntry(JSON.parse(trimmed));
    } catch {
      malformedLines += 1;
    }
  };

  for await (const rawChunk of stream) {
    const chunk = String(rawChunk);
    const bytes = Buffer.byteLength(chunk, "utf8");
    if (consumedBytes + bytes > maxFileBytes) {
      truncated = true;
      break;
    }
    consumedBytes += bytes;
    let cursor = 0;
    while (cursor <= chunk.length) {
      const newline = chunk.indexOf("\n", cursor);
      const end = newline < 0 ? chunk.length : newline;
      const piece = chunk.slice(cursor, end);
      if (!droppingOversizedLine) {
        if (pending.length + piece.length <= maxLineChars) pending += piece;
        else {
          pending = "";
          droppingOversizedLine = true;
          oversizedLines += 1;
        }
      }
      if (newline < 0) break;
      if (!droppingOversizedLine) processLine(pending);
      pending = "";
      droppingOversizedLine = false;
      cursor = newline + 1;
    }
  }
  if (!truncated && !droppingOversizedLine && pending) processLine(pending);
  return { truncated, malformedLines, oversizedLines };
}

async function mapConcurrent<T, U>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, progress: { completed: () => number }) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  let completed = 0;
  const count = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length || 1));
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], { completed: () => ++completed });
    }
  }));
  return results;
}

function snippetAround(text: string, query: string): string {
  const compact = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  if (!compact) return "(empty match)";
  const lower = normalize(compact);
  const phrase = normalize(query.trim());
  let index = lower.indexOf(phrase);
  let matchLength = phrase.length;
  if (index < 0) {
    for (const term of queryTerms(query)) {
      index = lower.indexOf(term);
      if (index >= 0) {
        matchLength = term.length;
        break;
      }
    }
  }
  if (index < 0) return compactText(compact, MAX_SNIPPET_CHARS);
  const radius = Math.floor((MAX_SNIPPET_CHARS - Math.min(matchLength, 80)) / 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(compact.length, index + Math.max(matchLength, 1) + radius);
  return compactText(`${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`, MAX_SNIPPET_CHARS);
}

function queryTerms(query: string): string[] {
  return [...new Set(normalize(query).split(/\s+/).filter(Boolean))];
}

function normalize(text: string): string {
  return sanitizeDisplayText(text).normalize("NFKC").toLocaleLowerCase();
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += Math.max(1, needle.length);
  }
  return count;
}

function tokenizeCommandArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  for (const character of input) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaping) current += "\\";
  if (quote) throw new Error("Unterminated quote in session-search query.");
  if (current) tokens.push(current);
  return tokens;
}

function findGitRoot(path: string): string | undefined {
  let current = canonicalPath(path);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const missingSegments: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    missingSegments.unshift(basename(existing));
    existing = parent;
  }
  try {
    return resolve(realpathSync.native(existing), ...missingSegments);
  } catch {
    return absolute;
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeJson(value: unknown): string {
  try {
    return value === undefined ? "" : JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function validDate(value: Date): Date {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date(0);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
