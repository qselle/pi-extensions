/** A configured key alone never opts a session into account usage. */
export function exaAccess(env: Record<string, string | undefined>): "keyless" | "api-key" {
  const access = env.PI_EXA_ACCESS?.trim() || "keyless";
  if (access !== "keyless" && access !== "api-key") throw new Error("PI_EXA_ACCESS must be keyless or api-key. No request was sent.");
  if (access === "api-key" && !env.EXA_API_KEY?.trim()) throw new Error("PI_EXA_ACCESS=api-key requires EXA_API_KEY. No request was sent.");
  return access;
}
