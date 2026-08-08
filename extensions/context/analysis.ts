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
  /** system + tools + conversation. */
  estimated: number;
  /** Pi's current context count, when available. */
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
  selectedTools?: readonly string[];
  promptGuidelines?: readonly string[];
  toolSnippets?: Readonly<Record<string, string>>;
  contextFiles?: readonly { path?: string; content?: string }[];
  skills?: readonly {
    name?: string;
    description?: string;
    filePath?: string;
    disableModelInvocation?: boolean;
  }[];
  appendSystemPrompt?: string;
  customPrompt?: string;
  window?: number;
  /** Pi's current context count. */
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

  return {
    window,
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
  if (hasReadTool(input.selectedTools)) {
    for (const skill of input.skills ?? []) {
      if (skill?.disableModelInvocation) continue;
      const name = skill?.name ?? "unnamed";
      addBucket(buckets, `skill:${name}`, `skill: ${name}`, estimate.text(skillPromptFragment(skill)));
    }
  }

  // A custom prompt replaces Pi's base prompt, including its tool snippets and
  // guidelines. The options remain populated, so mirror the builder's branch
  // instead of attributing text that was never sent.
  if (!input.customPrompt) {
    const guidelines = [...new Set((input.promptGuidelines ?? [])
      .map((guideline) => guideline.trim())
      .filter(Boolean))];
    addBucket(buckets, "guidelines", "guidelines", estimate.text(guidelines.join("\n")), countDetail(guidelines.length, "bullet"));

    const snippets = input.selectedTools === undefined
      ? Object.values(input.toolSnippets ?? {})
      : input.selectedTools
        .map((name) => input.toolSnippets?.[name])
        .filter((snippet): snippet is string => typeof snippet === "string" && snippet.length > 0);
    addBucket(buckets, "snippets", "tool snippets", estimate.text(snippets.join("\n")), countDetail(snippets.length, "tool"));
  }

  addBucket(buckets, "custom-prompt", "custom system prompt", estimate.text(input.customPrompt ?? ""));
  addBucket(buckets, "appended", "appended prompt", estimate.text(input.appendSystemPrompt ?? ""));

  const attributed = sumTokens(buckets);
  if (attributed < total) addBucket(buckets, "base", "pi base prompt", total - attributed);
  else if (attributed > total) {
    const reconciled = allocateTokens(total, buckets.map((bucket) => ({
      id: bucket.id,
      label: bucket.label,
      detail: bucket.detail,
      weight: bucket.tokens,
    }))).map(({ kind, tokens }) => ({
      id: kind.id,
      label: kind.label,
      tokens,
      ...(kind.detail ? { detail: kind.detail } : {}),
    })).filter((bucket) => bucket.tokens > 0);
    buckets.splice(0, buckets.length, ...reconciled);
  }

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
    const kinds = classify(entry);
    if (kinds.length === 0) return;
    const tokens = Math.max(0, estimate.entry(entry));
    for (const allocation of allocateTokens(tokens, kinds)) {
      if (allocation.tokens <= 0) continue;
      const id = sanitizeLabel(allocation.kind.id) || "unknown";
      const existing = grouped.get(id);
      if (existing) {
        existing.tokens += allocation.tokens;
        existing.count += 1;
      } else {
        grouped.set(id, {
          id,
          label: allocation.kind.label,
          tokens: allocation.tokens,
          count: 1,
        });
      }
    }
    if (tokens > 0) {
      // Position keeps otherwise identical rows (three big bash results) apart.
      const kind = largestEntryKind(entry);
      const detail = [kind.detail, `#${index + 1}`].filter(Boolean).join(" ");
      individual.push({ id: sanitizeLabel(kind.id) || "unknown", label: sanitizeLabel(kind.label), tokens, detail: sanitizeLabel(detail) });
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
  weight?: number;
}

function classify(entry: unknown): EntryKind[] {
  if (!entry || typeof entry !== "object") return [];
  const candidate = entry as {
    type?: string;
    customType?: string;
    content?: unknown;
    message?: {
      role?: string;
      customType?: string;
      toolName?: string;
      content?: unknown;
      command?: string;
      output?: string;
      excludeFromContext?: boolean;
    };
  };

  if (candidate.type === "compaction") return [{ id: "compaction", label: "compaction summary" }];
  if (candidate.type === "branch_summary") return [{ id: "branch-summary", label: "branch summaries" }];
  if (candidate.type === "custom_message") {
    const type = candidate.customType ?? "unknown";
    return [{ id: `custom:${type}`, label: `context: ${type}` }];
  }
  if (candidate.type !== "message") return [];

  const message = candidate.message;
  if (!message) return [];
  switch (message.role) {
    case "user":
      return [{ id: "user", label: "user messages" }];
    case "assistant":
      return assistantKinds(message.content);
    case "toolResult":
      return [{
        id: "tool-results",
        label: "tool results",
        ...(message.toolName ? { detail: message.toolName } : {}),
      }];
    case "bashExecution":
      return message.excludeFromContext
        ? []
        : [{ id: "bash-executions", label: "shell executions" }];
    case "custom": {
      const type = message.customType ?? candidate.customType ?? "unknown";
      return [{ id: `custom:${type}`, label: `context: ${type}` }];
    }
    default:
      return [{ id: "other", label: "other messages" }];
  }
}

function assistantKinds(content: unknown): EntryKind[] {
  if (!Array.isArray(content)) return [{ id: "assistant", label: "assistant replies" }];
  const weights = new Map<string, EntryKind>();
  const add = (id: string, label: string, weight: number) => {
    if (weight <= 0) return;
    const existing = weights.get(id);
    weights.set(id, { id, label, weight: (existing?.weight ?? 0) + weight });
  };

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
    if (block.type === "text") add("assistant-answers", "assistant answers", block.text?.length ?? 0);
    else if (block.type === "thinking") add("assistant-reasoning", "assistant reasoning", block.thinking?.length ?? 0);
    else if (block.type === "toolCall") {
      add("assistant-tool-calls", "tool calls and arguments", (block.name?.length ?? 0) + safeJson(block.arguments).length);
    }
  }

  return weights.size > 0 ? [...weights.values()] : [{ id: "assistant", label: "assistant replies" }];
}

function allocateTokens(total: number, kinds: readonly EntryKind[]): Array<{ kind: EntryKind; tokens: number }> {
  if (kinds.length === 0 || total <= 0) return [];
  if (kinds.length === 1) return [{ kind: kinds[0]!, tokens: total }];

  const weightTotal = kinds.reduce((sum, kind) => sum + Math.max(0, kind.weight ?? 0), 0);
  if (weightTotal <= 0) return [{ kind: kinds[0]!, tokens: total }];

  const allocations = kinds.map((kind, index) => {
    const exact = (total * Math.max(0, kind.weight ?? 0)) / weightTotal;
    return { kind, tokens: Math.floor(exact), remainder: exact - Math.floor(exact), index };
  });
  let remaining = total - allocations.reduce((sum, allocation) => sum + allocation.tokens, 0);
  for (const allocation of [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining-- <= 0) break;
    allocation.tokens += 1;
  }
  return allocations.map(({ kind, tokens }) => ({ kind, tokens }));
}

function largestEntryKind(entry: unknown): EntryKind {
  if (!entry || typeof entry !== "object") return { id: "other", label: "other messages" };
  const candidate = entry as {
    type?: string;
    customType?: string;
    message?: { role?: string; customType?: string; toolName?: string };
  };
  if (candidate.type === "compaction") return { id: "compaction", label: "compaction summary" };
  if (candidate.type === "branch_summary") return { id: "branch-summary", label: "branch summary" };
  if (candidate.type === "custom_message") {
    const type = candidate.customType ?? "unknown";
    return { id: `custom:${type}`, label: `context: ${type}` };
  }
  const message = candidate.message;
  if (message?.role === "toolResult") {
    return { id: "tool-results", label: "tool results", ...(message.toolName ? { detail: message.toolName } : {}) };
  }
  if (message?.role === "assistant") return { id: "assistant", label: "assistant message" };
  if (message?.role === "bashExecution") return { id: "bash-executions", label: "shell execution" };
  if (message?.role === "custom") {
    const type = message.customType ?? candidate.customType ?? "unknown";
    return { id: `custom:${type}`, label: `context: ${type}` };
  }
  if (message?.role === "user") return { id: "user", label: "user message" };
  return { id: "other", label: "other message" };
}

function addBucket(buckets: Bucket[], id: string, label: string, tokens: number, detail?: string): void {
  if (tokens > 0) {
    buckets.push({ id: sanitizeLabel(id) || "unknown", label: sanitizeLabel(label), tokens, ...(detail ? { detail: sanitizeLabel(detail) } : {}) });
  }
}

/**
 * Labels come from file paths, skill names, tool names, and customTypes, so they
 * are untrusted terminal input. Flatten them before they are persisted or drawn.
 */
export function sanitizeLabel(value: string): string {
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[P^_X][\s\S]*?(?:\u001b\\|\u0007)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
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
  const normalized = path.replace(/\\/g, "/");
  const normalizedCwd = cwd?.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedHome = home?.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalizedCwd && normalized.startsWith(`${normalizedCwd}/`)) return normalized.slice(normalizedCwd.length + 1);
  if (normalizedHome && normalized.startsWith(`${normalizedHome}/`)) return `~/${normalized.slice(normalizedHome.length + 1)}`;
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? normalized;
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

function hasReadTool(selectedTools: readonly string[] | undefined): boolean {
  return selectedTools === undefined || selectedTools.includes("read");
}

function skillPromptFragment(skill: NonNullable<AnalyzeInput["skills"]>[number]): string {
  return [
    "  <skill>",
    `    <name>${escapeXml(skill?.name ?? "unnamed")}</name>`,
    `    <description>${escapeXml(skill?.description ?? "")}</description>`,
    `    <location>${escapeXml(skill?.filePath ?? "")}</location>`,
    "  </skill>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
