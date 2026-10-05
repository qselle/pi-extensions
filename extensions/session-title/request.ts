import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { TITLE_SYSTEM_PROMPT, normalizeGeneratedTitle } from "./engine.ts";

export type TitleCompletion = (...args: Parameters<ModelRegistry["streamSimple"]>) => Promise<AssistantMessage>;

/** Titles are a few words; anything longer is the model ignoring instructions. */
const MAX_OUTPUT_TOKENS = 24;

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
    try {
      const response: any = await run(
        model,
        {
          systemPrompt: TITLE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
        },
        {
          signal: options.signal,
          maxTokens: MAX_OUTPUT_TOKENS,
          // Omit reasoning to request no optional thinking; Pi maps this to
          // each model's supported Off behavior ("off" is not a stream level).
          // A distinct routing id keeps this one-off prompt out of the main
          // session's prompt cache.
          sessionId: `${ctx.sessionManager?.getSessionId?.() ?? "session"}:title`,
        },
      );

      if (options.signal?.aborted || response?.stopReason === "aborted") return { error: "aborted" };
      if (response?.stopReason === "error") {
        lastError = response.errorMessage || `title request failed for ${model.provider}/${model.id}`;
        failures.push(`${model.provider}/${model.id} failed`);
        continue;
      }

      const title = normalizeGeneratedTitle(responseText(response));
      if (!title) {
        lastError = `model returned no usable title: ${model.provider}/${model.id}`;
        failures.push(`${model.provider}/${model.id} gave no usable title`);
        continue;
      }
      const used = `${model.provider}/${model.id}`;
      return {
        title,
        usage: usageOf(response),
        model: used,
        ...(preferred.length && used !== preferred[0] ? { fallback: `${failures.join("; ")}; used ${used}` } : {}),
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      failures.push(`${model.provider}/${model.id} failed`);
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
