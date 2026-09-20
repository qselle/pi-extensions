import { mistralReferenceRows, mistralSearchRequest } from "./mistral.ts";
import { searchExaKeyless } from "./exa-mcp.ts";
import { exaAccess } from "./access.ts";
import { requestWithRetry } from "./retry.ts";
import { publicationInWindow } from "./dates.ts";
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type Provider = "exa" | "firecrawl" | "mistral";
export type SearchQuality = "fast" | "balanced" | "deep";
export interface SearchInput {
  query: string;
  provider?: Provider;
  quality?: SearchQuality;
  additional_queries?: string[];
  limit?: number;
  domains?: string[];
  exclude_domains?: string[];
  category?: "news" | "pdf" | "github";
  date_range?: { start?: string; end?: string };
}
export interface SearchHit { title: string; url: string; snippet: string; published?: string; dateUncertain?: boolean }
export interface SearchDiagnostics { received: number; invalid: number; duplicate: number; outsideDomains: number; omitted: number; excludedDomains?: number; outsideDates?: number; uncertainDates?: number }
export interface SearchResult { provider: Provider; query: string; results: SearchHit[]; diagnostics?: SearchDiagnostics; dateRange?: { start?: string; end?: string }; quality?: SearchQuality; searchType?: string; warning?: string; access?: "keyless" | "api-key" }

/** Strip terminal controls from remote text before it reaches any renderer. */
export function cleanText(value: unknown, limit = 1200): string {
  if (typeof value !== "string") return "";
  return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, limit);
}

export function webUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use an HTTP(S) URL without embedded credentials.");
  }
  return url.href;
}

export function providerKey(provider: Provider): string {
  return provider === "exa" ? "EXA_API_KEY" : provider === "mistral" ? "MISTRAL_API_KEY" : "FIRECRAWL_API_KEY";
}

export function selectProvider(requested: Provider | undefined, env: Record<string, string | undefined>): Provider {
  const provider = requested ?? "exa";
  if (provider !== "exa" && !env[providerKey(provider)]?.trim()) throw new Error(`Configure ${providerKey(provider)} to use ${provider} search. No request was sent.`);
  return provider;
}

export function dateRangeFilter(range: SearchInput["date_range"], provider: Provider): Record<string, string> {
  if (range === undefined) return {};
  if (provider === "mistral") throw new Error("Mistral search does not support a strict date_range filter. Choose Exa or Firecrawl. No request was sent.");
  const valid = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  if (!range || (range.start === undefined && range.end === undefined) || (range.start !== undefined && !valid(range.start)) || (range.end !== undefined && !valid(range.end)) || (range.start !== undefined && range.end !== undefined && range.start > range.end)) {
    throw new Error("date_range requires at least one valid YYYY-MM-DD start/end date in chronological order. No request was sent.");
  }
  const calendar = (value: string) => { const [year, month, day] = value.split("-"); return `${Number(month)}/${Number(day)}/${year}`; };
  return provider === "exa" ? { ...(range.start ? { startPublishedDate: `${range.start}T00:00:00.000Z` } : {}), ...(range.end ? { endPublishedDate: `${range.end}T23:59:59.999Z` } : {}) }
    : { tbs: `cdr:1,cd_min:${range.start ? calendar(range.start) : ""},cd_max:${range.end ? calendar(range.end) : ""}` };
}

export function searchRequest(input: SearchInput, provider: Provider) {
  const quality = input.quality ?? "balanced";
  if (!["fast", "balanced", "deep"].includes(quality)) throw new Error("Search quality must be fast, balanced or deep. No request was sent.");
  if (provider !== "exa" && quality !== "balanced") throw new Error(`${quality} search requires Exa. Choose provider exa or use balanced. No request was sent.`);
  const additionalQueries = input.additional_queries?.map((query) => query.trim());
  if (additionalQueries && (quality !== "deep" || additionalQueries.length < 1 || additionalQueries.length > 5 || additionalQueries.some((query) => !query || query.length > 500))) {
    throw new Error("additional_queries requires deep search and 1–5 queries of 1–500 characters. No request was sent.");
  }
  const query = input.query.trim();
  if (!query || query.length > 500) throw new Error("Search query must contain 1–500 characters.");
  const limit = input.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("Search limit must be between 1 and 10.");
  const domains = input.domains?.map((domain) => domain.toLowerCase().trim());
  if (domains && (domains.length > 10 || domains.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)))) {
    throw new Error("Domains must be up to 10 hostnames without paths or protocols.");
  }
  const excluded = input.exclude_domains?.map((domain) => domain.toLowerCase().trim());
  if (excluded && (excluded.length > 10 || excluded.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)))) throw new Error("Excluded domains must be up to 10 hostnames without paths or protocols.");
  if (input.category && (provider !== "exa" || !["news", "pdf", "github"].includes(input.category))) throw new Error("category requires Exa and must be news, pdf or github. No request was sent.");
  const dates = dateRangeFilter(input.date_range, provider);
  const filter = domains?.length ? { includeDomains: domains } : {};
  if (provider === "mistral") return mistralSearchRequest(query, limit, domains);
  return provider === "exa"
    ? { url: "https://api.exa.ai/search", body: { query, numResults: limit, type: quality === "balanced" ? "auto" : quality, contents: { highlights: true }, ...(additionalQueries ? { additionalQueries } : {}), ...filter, ...(excluded?.length ? { excludeDomains: excluded } : {}), ...(input.category ? { category: input.category } : {}), ...dates } }
    : { url: "https://api.firecrawl.dev/v2/search", body: { query, limit, sources: ["web"], timeout: 25_000, ...filter, ...dates } };
}

export function normalizeResults(raw: unknown, provider: Provider, limit: number): SearchHit[] {
  return inspectResults(raw, provider, limit).results;
}

/** Domain matching includes subdomains, never lookalike suffixes or URL paths. */
export function inspectResults(raw: unknown, provider: Provider, limit: number, domains: readonly string[] = [], dateRange?: SearchInput["date_range"], excludedDomains: readonly string[] = []): { results: SearchHit[]; diagnostics: SearchDiagnostics; warning?: string } {
  const value = raw as { results?: unknown; success?: boolean; warning?: unknown; data?: { web?: unknown } } | null;
  const rows = provider === "exa" ? value?.results : provider === "mistral" ? mistralReferenceRows(raw) : value?.data?.web;
  if (value?.success === false || !Array.isArray(rows)) throw new Error(`${provider} returned an unexpected response.`);
  const results: SearchHit[] = [];
  const diagnostics: SearchDiagnostics = { received: rows.length, invalid: 0, duplicate: 0, outsideDomains: 0, omitted: 0 };
  if (dateRange) { diagnostics.outsideDates = 0; diagnostics.uncertainDates = 0; }
  const allowed = domains.map((domain) => domain.trim().toLowerCase());
  const denied = excludedDomains.map((domain) => domain.trim().toLowerCase());
  if (denied.length) diagnostics.excludedDomains = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.url !== "string" || row.url.length > 4096) { diagnostics.invalid++; continue; }
    let url: string;
    try { url = webUrl(row.url); } catch { diagnostics.invalid++; continue; }
    const canonical = new URL(url);
    canonical.hash = "";
    const hostname = canonical.hostname.toLowerCase().replace(/\.$/, "");
    if (allowed.length && !allowed.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) { diagnostics.outsideDomains++; continue; }
    if (denied.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) { diagnostics.excludedDomains!++; continue; }
    const dateMatch = dateRange ? publicationInWindow(row.publishedDate, dateRange) : undefined;
    if (dateMatch === "outside") { diagnostics.outsideDates!++; continue; }
    if (seen.has(canonical.href)) { diagnostics.duplicate++; continue; }
    seen.add(canonical.href);
    if (results.length >= limit) { diagnostics.omitted++; continue; }
    if (dateMatch === "uncertain") diagnostics.uncertainDates!++;
    const highlights = Array.isArray(row.highlights) ? row.highlights.filter((h: unknown) => typeof h === "string").join(" ") : "";
    results.push({
      url,
      title: cleanText(row.title, 240) || new URL(url).hostname,
      snippet: cleanText(highlights || row.description || row.text),
      ...(typeof row.publishedDate === "string" ? { published: cleanText(row.publishedDate, 40) } : {}),
      ...(dateMatch === "uncertain" ? { dateUncertain: true } : {}),
    });
  }
  const warning = provider === "firecrawl" ? cleanText(value?.warning, 500) : "";
  return { results, diagnostics, ...(warning ? { warning } : {}) };
}

export async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Search provider returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) throw new Error("Search provider response exceeded 2 MB.");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error("Search provider returned invalid JSON."); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function searchWeb(
  input: SearchInput,
  signal?: AbortSignal,
  env: Record<string, string | undefined> = process.env,
  request: Fetch = fetch,
): Promise<SearchResult> {
  signal?.throwIfAborted();
  const provider = selectProvider(input.provider ?? (input.quality === "fast" || input.quality === "deep" ? "exa" : undefined), env);
  const { url, body } = searchRequest(input, provider);
  const key = env[providerKey(provider)]?.trim();
  const timeout = AbortSignal.timeout(input.quality === "deep" || provider === "mistral" ? 60_000 : 30_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (provider === "exa" && exaAccess(env) === "keyless") {
    if (input.quality === "deep") throw new Error("Deep Exa search requires PI_EXA_ACCESS=api-key and EXA_API_KEY. Keyless access supports balanced and fast modes. No request was sent.");
    const raw = await searchExaKeyless({ query: input.query.trim(), numResults: input.limit ?? 5, type: input.quality === "fast" ? "fast" : "auto",
      ...(input.domains?.length ? { includeDomains: input.domains.map((domain) => domain.trim().toLowerCase()) } : {}), ...(input.exclude_domains?.length ? { excludeDomains: input.exclude_domains.map((domain) => domain.trim().toLowerCase()) } : {}), ...(input.category ? { category: input.category } : {}), ...dateRangeFilter(input.date_range, "exa") }, requestSignal, request);
    requestSignal.throwIfAborted();
    return { provider, access: "keyless", query: input.query.trim(), quality: input.quality ?? "balanced", searchType: input.quality === "fast" ? "fast" : "auto",
      ...(input.date_range ? { dateRange: { ...input.date_range } } : {}), ...inspectResults(raw, "exa", input.limit ?? 5, input.domains, input.date_range, input.exclude_domains) };
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider === "exa") headers["x-api-key"] = key!;
  else headers.Authorization = `Bearer ${key}`;
  const send: Fetch = provider === "exa" ? (url, init) => requestWithRetry(request, url, init!, false) : request;
  const response = await send(url, {
    method: "POST", headers, body: JSON.stringify(body), redirect: "error",
    signal: requestSignal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    const hint = response.status === 401 || response.status === 403 ? `Check ${providerKey(provider)}.`
      : response.status === 429 ? "Rate limited; try again later." : response.status === 402 ? "Check your provider credits." : "Try again later or choose another provider.";
    throw new Error(`${provider} search failed (HTTP ${response.status}). ${hint}`);
  }
  const raw = await boundedJson(response);
  signal?.throwIfAborted();
  return { provider, access: "api-key", query: input.query.trim(), quality: input.quality ?? "balanced", searchType: provider === "exa" ? (input.quality === "balanced" || !input.quality ? "auto" : input.quality) : provider === "mistral" ? "web_search citations" : "web", ...(input.date_range ? { dateRange: { ...input.date_range } } : {}), ...inspectResults(raw, provider, input.limit ?? 5, input.domains, input.date_range, input.exclude_domains) };
}

export function formatSearch(result: SearchResult): string {
  const header = `Search via ${result.provider}: ${cleanText(result.query, 500)}\nUntrusted web snippets; open sources to verify claims.`
    + (result.access ? `\nAccess: ${result.access === "keyless" ? "keyless hosted search; provider rate limits apply" : "API key"}.` : "")
    + (result.provider === "mistral" ? "\nSources are model-selected web_search citations, not a raw search listing. Descriptions are provider metadata; generated answer text is omitted. No citations does not prove the web has no matches." : "")
    + (result.quality ? `\nRequested search mode: ${result.quality} (${result.searchType}). This is not a verified quality rating.` : "")
    + (result.dateRange ? `\nRequested date range: ${result.dateRange.start ?? "any start"} through ${result.dateRange.end ?? "any end"}. Known out-of-range dates are excluded locally; verify publication dates on sources.` : "");
  const stats = result.diagnostics;
  const exclusions = stats ? [stats.invalid ? `${stats.invalid} invalid` : "", stats.duplicate ? `${stats.duplicate} duplicate` : "", stats.outsideDomains ? `${stats.outsideDomains} outside requested domains` : "", stats.excludedDomains ? `${stats.excludedDomains} excluded domains` : "", stats.outsideDates ? `${stats.outsideDates} outside requested dates` : "", stats.omitted ? `${stats.omitted} beyond result limit` : ""].filter(Boolean) : [];
  const report = (exclusions.length ? `\nProvider returned ${stats!.received} rows; excluded ${exclusions.join(", ")}.` : "")
    + (stats?.uncertainDates ? `\n${stats.uncertainDates} retained source(s) have unknown or imprecise publication dates; their date-range match is unverified.` : "")
    + (result.warning ? `\nProvider warning (untrusted): ${cleanText(result.warning, 500)}` : "");
  if (!result.results.length) return `${header}${report}\n${stats?.received ? "No usable results remain. Refine the query or domain filters." : result.warning ? "No sources returned. The provider reported a warning; this does not establish that no matches exist." : result.provider === "mistral" ? "No web citations returned. Search execution is not established by answer text alone." : "No results found."}`;
  return `${header}${report}\n\n${result.results.map((hit, i) =>
    `[${i + 1}] ${hit.title}\n${hit.url}${hit.published ? `\nPublished: ${hit.published}${hit.dateUncertain ? " (range match unverified)" : ""}` : hit.dateUncertain ? "\nPublished: unknown (range match unverified)" : ""}\n${hit.snippet}`
  ).join("\n\n")}`;
}
