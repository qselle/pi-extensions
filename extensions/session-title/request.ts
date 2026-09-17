import { complete } from "@earendil-works/pi-ai/compat";
import { TITLE_SYSTEM_PROMPT, normalizeGeneratedTitle } from "./engine.ts";

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
}

/** The slice of ExtensionContext this module needs, kept narrow for testing. */
export interface TitleRequestContext {
  model?: { provider: string; id: string; reasoning?: boolean };
  modelRegistry: {
    find(provider: string, id: string): unknown;
    getApiKeyAndHeaders(model: unknown): Promise<{
      ok: boolean;
      error?: string;
      apiKey?: string;
      /**
       * Pi's `ProviderHeaders`: a `null` value is a deletion marker for a default
       * header, so it must be forwarded to pi-ai unchanged rather than filtered.
       */
      headers?: Record<string, string | null>;
      env?: Record<string, string>;
    }>;
  };
  sessionManager?: { getSessionId?: () => string | undefined };
}

export interface RequestTitleOptions {
  ctx: TitleRequestContext;
  prompt: string;
  /** "provider/model" override from config. */
  override?: string;
  signal?: AbortSignal;
  /** Injectable for tests. */
  completion?: typeof complete;
}

/**
 * Runs one bounded titling request on a cheap model. Never throws: titling is
 * cosmetic, so every failure is returned as an error string for `/title status`
 * instead of disturbing the session.
 */
export async function requestTitle(options: RequestTitleOptions): Promise<TitleResult> {
  const { ctx, prompt } = options;
  const run = options.completion ?? complete;
  const models: any[] = [];
  let overrideFound = false;

  if (options.override) {
    const separator = options.override.indexOf("/");
    if (separator > 0) {
      const override = ctx.modelRegistry.find(
        options.override.slice(0, separator),
        options.override.slice(separator + 1),
      );
      if (override) {
        models.push(override);
        overrideFound = true;
      }
    }
  }
  const activeModel = ctx.model;
  if (activeModel && !models.some((model) => sameModel(model, activeModel))) models.push(activeModel);
  if (models.length === 0) return { error: "no model available for titling" };

  let lastError = options.override && !overrideFound
    ? `configured title model unavailable: ${options.override}`
    : "titling request failed";

  for (const model of models) {
    if (options.signal?.aborted) return { error: "aborted" };
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        lastError = auth.error || `no credentials for ${model.provider}/${model.id}`;
        continue;
      }

      const response: any = await run(
        model,
        {
          systemPrompt: TITLE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
        } as any,
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          signal: options.signal,
          maxTokens: MAX_OUTPUT_TOKENS,
          ...(model.reasoning ? { reasoning: "off" } : {}),
          // A distinct routing id keeps this one-off prompt out of the main
          // session's prompt cache.
          sessionId: `${ctx.sessionManager?.getSessionId?.() ?? "session"}:title`,
        } as any,
      );

      if (options.signal?.aborted || response?.stopReason === "aborted") return { error: "aborted" };
      if (response?.stopReason === "error") {
        lastError = response.errorMessage || `title request failed for ${model.provider}/${model.id}`;
        continue;
      }

      const title = normalizeGeneratedTitle(responseText(response));
      if (!title) {
        lastError = `model returned no usable title: ${model.provider}/${model.id}`;
        continue;
      }
      return {
        title,
        usage: usageOf(response),
        model: `${model.provider}/${model.id}`,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
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
