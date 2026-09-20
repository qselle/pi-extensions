export const SEARCH_CATEGORIES = ["news", "pdf", "github", "publication", "company", "people", "personal site", "financial report"] as const;
export type SearchCategory = typeof SEARCH_CATEGORIES[number];

interface DomainScope { value: string; host: string; path: string }

/** Normalize the host only: URL paths are case-sensitive. */
function domainScope(value: string): DomainScope {
  const input = value.trim();
  if (!input || input.length > 500 || /[\s\\?#@]/.test(input) || input.includes(":") || /%(?:2f|5c)/i.test(input)) {
    throw new Error("Domains must be hostnames with optional path prefixes, without protocols, credentials, ports, queries or fragments. No request was sent.");
  }
  const url = new URL(`https://${input}`);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(host)) throw new Error("Invalid domain hostname. No request was sent.");
  const path = url.pathname.replace(/\/+$/, "");
  // Reject malformed percent escapes before any provider call.
  try { decodeURIComponent(path); } catch { throw new Error("Invalid domain path encoding. No request was sent."); }
  return { value: host + path, host, path: decodeURIComponent(path) };
}

export function normalizeDomains(values: readonly string[] = []): string[] {
  if (values.length > 10) throw new Error("Use at most 10 domain restrictions. No request was sent.");
  return [...new Set(values.map((value) => domainScope(value).value))];
}

/** Apply path boundaries as well as host boundaries to every provider's results. */
export function domainMatcher(values: readonly string[]): (url: URL) => boolean {
  const scopes = values.map(domainScope);
  return (url) => {
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch { /* A malformed escape must not bypass host or literal path exclusions. */ }
    return scopes.some((scope) => (host === scope.host || host.endsWith(`.${scope.host}`))
      && (!scope.path || path === scope.path || path.startsWith(`${scope.path}/`)));
  };
}

export function freshnessOptions(maxAgeHours?: number): { maxAgeHours?: number } {
  if (maxAgeHours === undefined) return {};
  if (!Number.isInteger(maxAgeHours) || maxAgeHours < -1 || maxAgeHours > 720) throw new Error("max_age_hours must be an integer from -1 to 720 (0 requests fresh content, -1 cache only). No request was sent.");
  return { maxAgeHours };
}

export function freshnessLabel(maxAgeHours: number): string {
  return maxAgeHours === -1 ? "cache only" : maxAgeHours === 0 ? "fresh fetch" : `cache age ≤ ${maxAgeHours}h`;
}

/** Deduplicate tracking variants without rewriting the URL used for citations. */
export function sourceIdentity(url: URL): string {
  const key = new URL(url);
  key.hash = "";
  for (const name of [...key.searchParams.keys()]) {
    if (/^utm_/i.test(name) || /^(?:fbclid|gclid|dclid|msclkid)$/i.test(name)) key.searchParams.delete(name);
  }
  return key.href;
}
