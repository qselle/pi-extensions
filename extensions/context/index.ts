/**
 * context — see where the context window actually goes.
 *
 * `/context` reports three regions separately, because they are billed from
 * different places in a request: the system prompt string, the tool schemas, and
 * the conversation that survived compaction. Extension injections are itemized
 * per `customType`, so `goal`, `plan`, and `memory` show their own footprint.
 *
 * Token figures use the same chars/4 heuristic as pi's own estimator, so they
 * agree with the compaction decisions that actually affect a session. The
 * provider's own count is shown alongside when pi has one.
 */

import { DEFAULT_COMPACTION_SETTINGS, estimateTokens, getLastAssistantUsage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { analyzeContext, shortenPath, type ContextReport, type Estimators, type ProviderUsage, type ToolLike } from "./analysis.ts";
import { renderReport, summaryLine, type ReportTheme } from "./render.ts";

export const CONTEXT_REPORT_ENTRY = "context-report";

const FALLBACK_WIDTH = 80;

/** chars/4 — the heuristic pi documents for its own message estimator. */
function estimateText(value: string): number {
  return Math.ceil(value.length / 4);
}

/** Production estimators: pi's own for messages, its heuristic for loose text. */
export const piEstimators: Estimators = {
  text: estimateText,
  entry: (entry: unknown) => {
    const candidate = entry as { type?: string; message?: unknown; summary?: unknown };
    if (candidate?.type === "message" && candidate.message) {
      try {
        return estimateTokens(candidate.message as never);
      } catch {
        return 0;
      }
    }
    // Compaction and branch-summary entries carry their text as `summary`.
    return typeof candidate?.summary === "string" ? estimateText(candidate.summary) : 0;
  },
};

/** Reads the provider's usage components for the last response. */
export type LastUsageReader = (entries: readonly unknown[]) => Partial<ProviderUsage> | undefined;

const readPiLastUsage: LastUsageReader = (entries) => {
  const usage = getLastAssistantUsage(entries as never);
  return usage
    ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }
    : undefined;
};

const PLAIN_THEME: ReportTheme = { fg: (_color, text) => text, bold: (text) => text };

interface SystemPromptOptionsLike {
  promptGuidelines?: readonly string[];
  toolSnippets?: Readonly<Record<string, string>>;
  contextFiles?: readonly { path?: string; content?: string }[];
  skills?: readonly { name?: string; content?: string }[];
  appendSystemPrompt?: string;
  customPrompt?: string;
}

/** The slice of the command context this extension reads, kept narrow for tests. */
export interface ContextCommandContext {
  mode?: string;
  cwd?: string;
  ui: {
    notify(message: string, level?: string): void;
  };
  model?: { contextWindow?: number };
  getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | undefined;
  getSystemPrompt?: () => string;
  getSystemPromptOptions?: () => SystemPromptOptionsLike | undefined;
  sessionManager?: {
    buildContextEntries?: () => unknown[];
    getBranch?: () => unknown[];
  };
}

export interface ContextHost {
  getAllTools?: () => readonly (ToolLike & { name?: string })[];
  getActiveTools?: () => readonly string[];
}

/**
 * Builds the report from what pi currently has loaded.
 *
 * Only *active* tools are measured: an inactive registered tool costs nothing
 * because its schema is never sent.
 */
export function collectReport(
  host: ContextHost,
  ctx: ContextCommandContext,
  estimate: Estimators = piEstimators,
  readLastUsage: LastUsageReader = readPiLastUsage,
): ContextReport {
  const options = safeCall(() => ctx.getSystemPromptOptions?.()) ?? {};
  const usage = safeCall(() => ctx.getContextUsage?.());
  const entries = safeCall(() => ctx.sessionManager?.buildContextEntries?.())
    ?? safeCall(() => ctx.sessionManager?.getBranch?.())
    ?? [];

  const allTools = safeCall(() => host.getAllTools?.()) ?? [];
  const activeNames = new Set(safeCall(() => host.getActiveTools?.()) ?? []);
  const tools = activeNames.size > 0
    ? allTools.filter((tool) => tool?.name !== undefined && activeNames.has(tool.name))
    : allTools;

  const reported = typeof usage?.tokens === "number" && usage.tokens > 0 ? usage.tokens : undefined;
  // The raw components explain any gap between pi's figure and the estimate.
  const lastUsage = safeCall(() => readLastUsage(entries));

  // Absolute paths would push every number off the right edge of the table.
  const contextFiles = (options.contextFiles ?? []).map((file) => ({
    path: shortenPath(file?.path ?? "", ctx.cwd, safeCall(() => homedir())),
    content: file?.content ?? "",
  }));

  return analyzeContext({
    entries,
    systemPrompt: safeCall(() => ctx.getSystemPrompt?.()) ?? "",
    tools,
    promptGuidelines: options.promptGuidelines,
    toolSnippets: options.toolSnippets,
    contextFiles,
    skills: options.skills,
    appendSystemPrompt: options.appendSystemPrompt,
    customPrompt: options.customPrompt,
    window: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
    reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    ...(reported !== undefined ? { reportedTokens: reported } : {}),
    ...(lastUsage
      ? {
        providerUsage: {
          input: lastUsage.input,
          output: lastUsage.output,
          cacheRead: lastUsage.cacheRead,
          cacheWrite: lastUsage.cacheWrite,
        },
      }
      : {}),
  }, estimate);
}

/** Renders at the width pi gives it, so the table adapts to the terminal. */
class ReportCard {
  constructor(
    private readonly report: ContextReport,
    private readonly theme: ReportTheme,
  ) {}

  render(width: number): string[] {
    return renderReport(this.report, this.theme, width);
  }

  invalidate(): void {}
}

export interface ContextExtensionOptions {
  estimators?: Estimators;
  readLastUsage?: LastUsageReader;
}

export default function contextExtension(pi: ExtensionAPI, options: ContextExtensionOptions = {}): void {
  const estimate = options.estimators ?? piEstimators;
  const readLastUsage = options.readLastUsage ?? readPiLastUsage;

  // A custom entry rather than a message: the report is for you, not the model,
  // and must never enter the conversation it is measuring.
  pi.registerEntryRenderer(CONTEXT_REPORT_ENTRY, (entry: any, _renderOptions: any, theme: any) =>
    new ReportCard(entry?.data?.report ?? emptyReport(), theme) as any);

  pi.registerCommand("context", {
    description: "Show where the context window is going",
    handler: async (_args: string, ctx: any) => {
      const report = collectReport(pi as ContextHost, ctx as ContextCommandContext, estimate, readLastUsage);
      if (ctx.mode === "tui") {
        pi.appendEntry(CONTEXT_REPORT_ENTRY, { report });
        return;
      }
      ctx.ui.notify(renderReport(report, PLAIN_THEME, FALLBACK_WIDTH).join("\n"), "info");
    },
  });
}

export function reportSummary(report: ContextReport): string {
  return summaryLine(report);
}

function emptyReport(): ContextReport {
  const empty = { total: 0, buckets: [] };
  return { window: 0, estimated: 0, system: empty, tools: empty, conversation: empty, largest: [] };
}

function safeCall<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
