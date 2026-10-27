import type { AssistantMessage, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { TITLE_SYSTEM_PROMPT, normalizeGeneratedTitle } from "./engine.ts";

export type TitleCompletion = (...args: Parameters<ModelRegistry["streamSimple"]>) => Promise<AssistantMessage>;

/** Titles are a few words; anything longer is the model ignoring instructions. */
const MAX_OUTPUT_TOKENS = 24;
/** Reasoning models can spend output tokens thinking even with thinking off. */
const REASONING_TOKENS = 512;
/** Extra room when a model is configured to think. */
const THINKING_TOKENS = 2_048;
/** A stalled model must not hold the title; the next model gets a turn. */
export const REQUEST_TIMEOUT_MS = 20_000;

export interface TitleUsage {
  input: number;
  output: number;
  cost: number;
}

export interface TitleResult {
  title?: string;
  usage?: TitleUsage;
  model?: string;
  error?: string;
  /** Set when a configured preferred model was skipped, e.g. "x unavailable; used y". */
  fallback?: string;
  /** Structured requests: one-sentence summary of the latest turn. */
  turn?: string;
  /** Structured requests: the session's durable objective. */
  focus?: string;
}

export interface ParsedTitle {
  title?: string;
  turn?: string;
  focus?: string;
}

export interface TitleRequestContext {
  model?: { provider: string; id: string; reasoning?: boolean };
  modelRegistry: {
    find(provider: string, id: string): unknown;
    streamSimple: ModelRegistry["streamSimple"];
  };
  sessionManager?: { getSessionId?: () => string | undefined };
}

export interface RequestTitleOptions {
  ctx: TitleRequestContext;
  prompt: string;
  /** "provider/model" override from config. */
  override?: string;
  /** Ordered "provider/model" preferences; replaces `override` when non-empty. */
  overrides?: readonly string[];
  signal?: AbortSignal;
  completion?: TitleCompletion;
  /** Thinking level per "provider/model"; unset or "off" requests no optional thinking. */
  thinking?: Readonly<Record<string, ModelThinkingLevel>>;
  /** Structured requests replace the plain-title prompt, budget, and parser. */
  systemPrompt?: string;
  maxTokens?: number;
  parse?: (text: string) => ParsedTitle;
  /** Per-model deadline; defaults to REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Return failures for /title status without interrupting the main turn. */
export async function requestTitle(options: RequestTitleOptions): Promise<TitleResult> {
  const { ctx, prompt } = options;
  const run: TitleCompletion = options.completion ?? ((...args) => ctx.modelRegistry.streamSimple(...args).result());
  const preferred = options.overrides?.length ? options.overrides : options.override ? [options.override] : [];
  const models: any[] = [];
  const failures: string[] = [];
  for (const name of preferred) {
    const separator = name.indexOf("/");
    const model = separator > 0 ? ctx.modelRegistry.find(name.slice(0, separator), name.slice(separator + 1)) : undefined;
    if (!model) failures.push(`${name} unavailable`);
    else if (!models.some((known) => sameModel(known, model as any))) models.push(model);
  }
  const activeModel = ctx.model;
  if (activeModel && !models.some((model) => sameModel(model, activeModel))) models.push(activeModel);
  if (models.length === 0) return { error: "no model available for titling" };

  let lastError = preferred.length && failures.length === preferred.length
    ? `configured title model unavailable: ${preferred.join(", ")}`
    : "titling request failed";

  for (const model of models) {
    if (options.signal?.aborted) return { error: "aborted" };
    const name = `${model.provider}/${model.id}`;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const timedOut = () => {
      lastError = `title request timed out: ${name}`;
      failures.push(`${name} timed out`);
    };
    // Pi maps an omitted level to each model's Off behavior ("off" is not a stream level).
    const configured = options.thinking?.[name];
    const reasoning = model.reasoning && configured && configured !== "off" ? configured as ThinkingLevel : undefined;
    const base = options.maxTokens ?? MAX_OUTPUT_TOKENS;
    try {
      const response: any = await run(
        model,
        {
          systemPrompt: options.systemPrompt ?? TITLE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
        },
        {
          signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
          maxTokens: model.reasoning ? base + (reasoning ? THINKING_TOKENS : REASONING_TOKENS) : base,
          ...(reasoning ? { reasoning } : {}),
          // A distinct routing id keeps this one-off prompt out of the main
          // session's prompt cache.
          sessionId: `${ctx.sessionManager?.getSessionId?.() ?? "session"}:title`,
        },
      );

      if (options.signal?.aborted) return { error: "aborted" };
      if (timeout.aborted) {
        timedOut();
        continue;
      }
      if (response?.stopReason === "aborted") return { error: "aborted" };
      if (response?.stopReason === "error") {
        lastError = response.errorMessage || `title request failed for ${name}`;
        failures.push(`${name} failed`);
        continue;
      }

      const text = responseText(response);
      const parsed = options.parse ? options.parse(text) : { title: text };
      const title = normalizeGeneratedTitle(parsed.title);
      if (!title) {
        lastError = `model returned no usable title: ${name}`;
        failures.push(`${name} gave no usable title`);
        continue;
      }
      return {
        title,
        usage: usageOf(response),
        model: name,
        ...(preferred.length && name !== preferred[0] ? { fallback: `${failures.join("; ")}; used ${name}` } : {}),
        ...(parsed.turn ? { turn: parsed.turn } : {}),
        ...(parsed.focus ? { focus: parsed.focus } : {}),
      };
    } catch (error) {
      if (options.signal?.aborted) return { error: "aborted" };
      if (timeout.aborted) {
        timedOut();
        continue;
      }
      lastError = error instanceof Error ? error.message : String(error);
      failures.push(`${name} failed`);
    }
  }

  return { error: lastError };
}

function sameModel(left: { provider?: unknown; id?: unknown }, right: { provider?: unknown; id?: unknown }): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function responseText(response: any): string {
  const content = response?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join(" ")
    .trim();
}

function usageOf(response: any): TitleUsage | undefined {
  const usage = response?.usage;
  if (!usage) return undefined;
  const positive = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  return {
    input: positive(usage.input) + positive(usage.cacheRead) + positive(usage.cacheWrite),
    output: positive(usage.output),
    cost: positive(usage.cost?.total),
  };
}
