/** Use the configured account when available; otherwise use public Exa. */
export function exaAccess(env: Record<string, string | undefined>): "keyless" | "api-key" {
  return env.EXA_API_KEY?.trim() ? "api-key" : "keyless";
}
