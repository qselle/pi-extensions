export type ExaAccess = "keyless" | "api-key";
export type ExaMode = "auto" | "keyless" | "api-key";
type Env = Record<string, string | undefined>;

/** `PI_EXA_ACCESS` forces one access mode; anything else is `auto`. */
export function exaMode(env: Env): ExaMode {
  const mode = env.PI_EXA_ACCESS?.trim().toLowerCase();
  return mode === "keyless" || mode === "api-key" ? mode : "auto";
}

export interface ExaAccessPlan { first: ExaAccess; paidFallback: boolean }

/**
 * Hosted keyless access first; a configured key is used only after the free tier answers
 * 401/402/403/429, or immediately for features that require it (deep search, freshness reads)
 * or when `PI_EXA_ACCESS=api-key`. `PI_EXA_ACCESS=keyless` never sends the key.
 */
export function exaAccessPlan(env: Env, requiresKey = false): ExaAccessPlan {
  const keyed = !!env.EXA_API_KEY?.trim();
  const mode = exaMode(env);
  if (!keyed || mode === "keyless") return { first: "keyless", paidFallback: false };
  if (mode === "api-key" || requiresKey) return { first: "api-key", paidFallback: false };
  return { first: "keyless", paidFallback: true };
}

/** Whether a request needing an API key can be served under the current configuration. */
export const exaKeyAvailable = (env: Env) => !!env.EXA_API_KEY?.trim() && exaMode(env) !== "keyless";

/** First access of a default request. */
export const exaAccess = (env: Env): ExaAccess => exaAccessPlan(env).first;

/** Statuses after which the paid key may succeed where the free tier failed. */
export const PAID_FALLBACK_STATUSES = [401, 402, 403, 429];

export function exaAccessSummary(env: Env): string {
  const plan = exaAccessPlan(env);
  if (plan.paidFallback) return "public access first · API key after rate limits or access errors";
  if (plan.first === "api-key") return "API key";
  return env.EXA_API_KEY?.trim() ? "public access · PI_EXA_ACCESS=keyless ignores EXA_API_KEY" : "public access";
}
