import { complete } from "@earendil-works/pi-ai/compat";
import { TITLE_SYSTEM_PROMPT, normalizeTitle, selectTitleModel } from "./engine.ts";

/** Titles are a few words; anything longer is the model ignoring instructions. */
const MAX_OUTPUT_TOKENS = 32;

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
  model?: { provider: string; id: string };
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
  try {
    const model = selectTitleModel(
      (provider, id) => ctx.modelRegistry.find(provider, id),
      { override: options.override, fallback: ctx.model },
    ) as any;
    if (!model) return { error: "no model available for titling" };

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return { error: auth.error || "no credentials for titling model" };

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
        // A distinct routing id keeps this one-off prompt out of the main
        // session's prompt cache.
        sessionId: `${ctx.sessionManager?.getSessionId?.() ?? "session"}:title`,
      } as any,
    );

    if (options.signal?.aborted || response?.stopReason === "aborted") return { error: "aborted" };
    if (response?.stopReason === "error") return { error: response.errorMessage || "titling request failed" };

    const label = `${model.provider}/${model.id}`;
    const title = normalizeTitle(responseText(response));
    return { title, usage: usageOf(response), model: label, error: title ? undefined : "model returned no usable title" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
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
