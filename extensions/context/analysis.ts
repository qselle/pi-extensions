/**
 * Context attribution.
 *
 * Deliberately free of pi imports: the estimators are injected, so this module
 * is pure data in, plain numbers out, and its tests never depend on the
 * process-wide module mocks other suites install.
 *
 * Tokens live in three different places in a request, and conflating them is
 * what makes a single "system prompt" figure misleading:
 *
 *   1. the system prompt string   (base prompt, guidelines, tool snippets,
 *                                  context files, skills, appended text)
 *   2. the tool schemas           (sent as the request's tool array, not as
 *                                  part of the prompt text)
 *   3. the conversation           (the entries that survive compaction)
 */

export interface Bucket {
  id: string;
  label: string;
  tokens: number;
  detail?: string;
}

export interface Section {
  total: number;
  buckets: Bucket[];
}

export interface ProviderUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ContextReport {
  /** Model context window, or 0 when unknown. */
  window: number;
  /** Token count at which pi starts compacting, when it can be derived. */
  compactAt?: number;
  /** system + tools + conversation. */
  estimated: number;
  /** The provider's own count for the last response, when available. */
  reported?: number;
  /** Raw components behind `reported`, so a divergence explains itself. */
  provider?: ProviderUsage;
  system: Section;
  tools: Section;
  conversation: Section;
  /** Heaviest individual entries, largest first. */
  largest: Bucket[];
}

export interface Estimators {
  /** Tokens for a plain string. */
  text: (value: string) => number;
  /** Tokens for one session entry; pi's own estimator in production. */
  entry: (entry: unknown) => number;
}

export interface ToolLike {
  name?: string;
  description?: string;
  parameters?: unknown;
}

export interface AnalyzeInput {
  /** Entries actually in context, i.e. sessionManager.buildContextEntries(). */
  entries?: readonly unknown[];
  /** The current system prompt string. */
  systemPrompt?: string;
  tools?: readonly ToolLike[];
  promptGuidelines?: readonly string[];
  toolSnippets?: Readonly<Record<string, string>>;
  contextFiles?: readonly { path?: string; content?: string }[];
  skills?: readonly { name?: string; content?: string }[];
  appendSystemPrompt?: string;
  customPrompt?: string;
  window?: number;
  /** Compaction reserve; pi compacts once usage passes window - reserve. */
  reserveTokens?: number;
  /** Provider-reported context tokens for the last response. */
  reportedTokens?: number;
  /** Raw usage components from the last response, when available. */
  providerUsage?: Partial<ProviderUsage>;
  largestCount?: number;
}

const DEFAULT_LARGEST = 5;

export function analyzeContext(input: AnalyzeInput, estimate: Estimators): ContextReport {
  const system = systemSection(input, estimate);
  const tools = toolSection(input.tools ?? [], estimate);
  const { section: conversation, entries } = conversationSection(input.entries ?? [], estimate);
  const window = positive(input.window);
  const compactAt = window > 0 && input.reserveTokens !== undefined
    ? Math.max(0, window - positive(input.reserveTokens))
    : undefined;

  return {
    window,
    compactAt,
    estimated: system.total + tools.total + conversation.total,
    reported: input.reportedTokens !== undefined ? positive(input.reportedTokens) : undefined,
    ...(input.providerUsage ? { provider: normalizeUsage(input.providerUsage) } : {}),
    system,
    tools,
    conversation,
    largest: entries
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, Math.max(0, input.largestCount ?? DEFAULT_LARGEST)),
  };
}

/**
 * The system prompt string, itemized.
 *
 * The total is the measured prompt rather than the sum of the parts, so the
 * unattributed remainder shows up as pi's base prompt instead of silently
 * disappearing.
 */
function systemSection(input: AnalyzeInput, estimate: Estimators): Section {
  const total = estimate.text(input.systemPrompt ?? "");
  const buckets: Bucket[] = [];

  for (const file of input.contextFiles ?? []) {
    const label = file?.path ?? "context file";
    addBucket(buckets, `file:${label}`, label, estimate.text(file?.content ?? ""));
  }
  for (const skill of input.skills ?? []) {
    const name = skill?.name ?? "unnamed";
    addBucket(buckets, `skill:${name}`, `skill: ${name}`, estimate.text(skill?.content ?? ""));
  }

  const guidelines = input.promptGuidelines ?? [];
  addBucket(buckets, "guidelines", "guidelines", estimate.text(guidelines.join("\n")), countDetail(guidelines.length, "bullet"));

  const snippets = Object.values(input.toolSnippets ?? {});
  addBucket(buckets, "snippets", "tool snippets", estimate.text(snippets.join("\n")), countDetail(snippets.length, "tool"));

  addBucket(buckets, "custom-prompt", "custom system prompt", estimate.text(input.customPrompt ?? ""));
  addBucket(buckets, "appended", "appended prompt", estimate.text(input.appendSystemPrompt ?? ""));

  const attributed = buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
  addBucket(buckets, "base", "pi base prompt", Math.max(0, total - attributed));

  return { total, buckets: sortBuckets(buckets) };
}

/** Tool schemas, which are sent alongside the prompt rather than inside it. */
function toolSection(tools: readonly ToolLike[], estimate: Estimators): Section {
  const buckets: Bucket[] = [];
  for (const tool of tools) {
    const name = tool?.name ?? "unnamed";
    const schema = [name, tool?.description ?? "", safeJson(tool?.parameters)].join("\n");
    addBucket(buckets, `tool:${name}`, name, estimate.text(schema));
  }
  return { total: sumTokens(buckets), buckets: sortBuckets(buckets) };
}

interface ConversationResult {
  section: Section;
  entries: Bucket[];
}

/**
 * Conversation entries, grouped by kind.
 *
 * Custom context messages are grouped per `customType` rather than lumped
 * together, because that is what makes an extension's own injections visible.
 */
function conversationSection(entries: readonly unknown[], estimate: Estimators): ConversationResult {
  const grouped = new Map<string, Bucket & { count: number }>();
  const individual: Bucket[] = [];

  entries.forEach((entry, index) => {
    const kind = classify(entry);
    if (!kind) return;
    const tokens = Math.max(0, estimate.entry(entry));
    const existing = grouped.get(kind.id);
    if (existing) {
      existing.tokens += tokens;
      existing.count += 1;
    } else {
      grouped.set(kind.id, { id: kind.id, label: kind.label, tokens, count: 1 });
    }
    if (tokens > 0) {
      // Position keeps otherwise identical rows (three big bash results) apart.
      const detail = [kind.detail, `#${index + 1}`].filter(Boolean).join(" ");
      individual.push({ id: kind.id, label: sanitizeLabel(kind.label), tokens, detail: sanitizeLabel(detail) });
    }
  });

  const buckets = [...grouped.values()].map(({ count, ...bucket }) => ({
    ...bucket,
    label: sanitizeLabel(bucket.label),
    ...(countDetail(count, "entry", "entries") ? { detail: countDetail(count, "entry", "entries")! } : {}),
  }));

  return {
    section: { total: sumTokens(buckets), buckets: sortBuckets(buckets) },
    entries: individual,
  };
}

interface EntryKind {
  id: string;
  label: string;
  detail?: string;
}

function classify(entry: unknown): EntryKind | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const candidate = entry as {
    type?: string;
    customType?: string;
    message?: { role?: string; customType?: string; toolName?: string };
  };

  if (candidate.type === "compaction") return { id: "compaction", label: "compaction summary" };
  if (candidate.type === "branch_summary") return { id: "branch-summary", label: "branch summaries" };
  if (candidate.type !== "message") return undefined;

  const message = candidate.message;
  if (!message) return undefined;
  switch (message.role) {
    case "user":
      return { id: "user", label: "user messages" };
    case "assistant":
      return { id: "assistant", label: "assistant replies" };
    case "toolResult":
      return {
        id: "tool-results",
        label: "tool results",
        ...(message.toolName ? { detail: message.toolName } : {}),
      };
    case "custom": {
      const type = message.customType ?? candidate.customType ?? "unknown";
      return { id: `custom:${type}`, label: `context: ${type}` };
    }
    default:
      return { id: "other", label: "other messages" };
  }
}

function addBucket(buckets: Bucket[], id: string, label: string, tokens: number, detail?: string): void {
  if (tokens > 0) {
    buckets.push({ id, label: sanitizeLabel(label), tokens, ...(detail ? { detail: sanitizeLabel(detail) } : {}) });
  }
}

/**
 * Labels come from file paths, skill names, tool names, and customTypes, so they
 * are untrusted terminal input. Flatten them before they are persisted or drawn.
 */
export function sanitizeLabel(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/**
 * Readable label for a context file: relative to the session when possible, then
 * home-relative, else just the file name. Absolute paths are long enough to push
 * every number off the right edge of the table.
 */
export function shortenPath(path: string, cwd?: string, home?: string): string {
  if (!path) return "context file";
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function sumTokens(buckets: readonly Bucket[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
}

function sortBuckets(buckets: Bucket[]): Bucket[] {
  return [...buckets].sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
}

function countDetail(count: number, singular: string, plural = `${singular}s`): string | undefined {
  if (count <= 0) return undefined;
  return `${count} ${count === 1 ? singular : plural}`;
}

function safeJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function positive(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeUsage(usage: Partial<ProviderUsage>): ProviderUsage {
  return {
    input: positive(usage.input),
    output: positive(usage.output),
    cacheRead: positive(usage.cacheRead),
    cacheWrite: positive(usage.cacheWrite),
  };
}
