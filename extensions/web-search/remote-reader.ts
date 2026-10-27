import { exaAccessPlan, exaKeyAvailable, PAID_FALLBACK_STATUSES } from "./access.ts";
import { boundedJson, webUrl, type Fetch } from "./client.ts";
import { callExaKeyless } from "./exa-mcp.ts";
import { McpError } from "./mcp.ts";
import { requestWithRetry } from "./retry.ts";
import type { PageResult, ReadAttempt, ReadInput, RemoteReader } from "./reader.ts";
import { mistralOpenFailure, openMistral } from "./mistral.ts";
import { PlainOutput } from "../../lib/output.ts";
import { freshnessOptions } from "./filters.ts";
import { pageContentFailure } from "./page-content.ts";

type Env = Record<string, string | undefined>;
const READ_TIMEOUT_MS = 30_000;
const NAMES: Record<RemoteReader, string> = { exa: "Exa", firecrawl: "Firecrawl", mistral: "Mistral" };
/** Mistral news results without a URL open by this ID. */
export const ARTICLE_ID = /^[\w-]{1,128}$/;

/** Remote readers return a bounded Markdown excerpt only; validate before any request. */
function excerptBudget(input: ReadInput, reader: RemoteReader): number {
  if ((input.mode !== undefined && input.mode !== "markdown") || input.selector !== undefined || (input.offset !== undefined && input.offset !== 0)) throw new Error(`${NAMES[reader]} reading supports a bounded excerpt only; selectors, outlines and continuation require ax. No request was sent.`);
  const budget = input.budget ?? 2000;
  if (!Number.isInteger(budget) || budget < 100 || budget > 8000) throw new Error("Budget must be between 100 and 8000 tokens.");
  if (reader !== "exa" && input.max_age_hours !== undefined) throw new Error("max_age_hours requires reader=exa. No request was sent.");
  return Math.min(40_000, budget * 4);
}

function readSignal(signal: AbortSignal | undefined, deadline: number) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(deadline - performance.now())));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Shared cleanup, challenge detection and truncation for remote excerpts. */
function excerpt(reader: RemoteReader, text: string, limit: number) {
  const cleaned = new PlainOutput().push(text);
  const failure = (reader === "mistral" ? mistralOpenFailure(cleaned) : undefined) ?? pageContentFailure(cleaned);
  if (failure) throw new Error(`${NAMES[reader]} ${failure}. Try another source or a direct local read.`);
  return { text: cleaned.slice(0, limit), truncated: cleaned.length >= limit };
}

const REMOTE_NOTES = "Remote extraction follows the provider's cache policy; freshness is not independently verified. PDF text, tables and figures can be incomplete. The returned excerpt has no continuation token; verify quotations against the original.";

/** Explicit remote fallback: never uploads local files and never switches access policy. */
export async function readExaPage(input: ReadInput, signal?: AbortSignal, env: Env = process.env, request: Fetch = fetch, deadlineAt = performance.now() + READ_TIMEOUT_MS): Promise<PageResult> {
  const url = webUrl(input.url);
  const limit = excerptBudget(input, "exa");
  const freshness = freshnessOptions(input.max_age_hours);
  if (input.max_age_hours !== undefined && !exaKeyAvailable(env)) throw new Error("Public Exa page reading does not expose freshness controls. Use ax for a direct fetch, or set EXA_API_KEY. No request was sent.");
  const plan = exaAccessPlan(env, input.max_age_hours !== undefined);
  const requestSignal = readSignal(signal, deadlineAt);
  requestSignal.throwIfAborted();
  let text: string | undefined;
  let sourceUrl: string | undefined;
  let access = plan.first;
  let accessFallback: string | undefined;
  if (plan.first === "keyless") {
    try {
      const result = await callExaKeyless("web_fetch_exa", { urls: [url], maxCharacters: limit }, requestSignal, request, { deadline: deadlineAt, paidFallback: plan.paidFallback });
      const blocks = result.content;
      if (!Array.isArray(blocks) || !blocks.length || blocks.some((block) => block?.type !== "text" || typeof block.text !== "string")) throw new Error("Exa returned an unsupported page response.");
      text = blocks.map((block) => block.text).join("\n\n");
      // MCP supplies prose, not structured redirect metadata. Do not promote a
      // URL inside untrusted page text to a verified final URL.
    } catch (error) {
      requestSignal.throwIfAborted();
      if (!plan.paidFallback || !(error instanceof McpError) || !PAID_FALLBACK_STATUSES.includes(error.status ?? 0)) throw error;
      access = "api-key";
      accessFallback = `HTTP ${error.status}`;
    }
  }
  if (text === undefined) {
    const response = await requestWithRetry(request, "https://api.exa.ai/contents", { method: "POST", headers: { "content-type": "application/json", "x-api-key": env.EXA_API_KEY!.trim() }, body: JSON.stringify({ urls: [url], text: { maxCharacters: limit }, ...freshness }), signal: requestSignal, redirect: "error" }, { deadline: deadlineAt, rateLimit: true });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Exa page reading failed (HTTP ${response.status}). No access mode was changed.`); }
    const raw = await boundedJson(response) as { results?: { text?: unknown; url?: unknown }[] };
    const row = raw?.results?.[0];
    if (!row || typeof row.text !== "string" || !row.text.trim()) throw new Error("Exa returned no readable content for this URL.");
    text = row.text;
    if (typeof row.url === "string") sourceUrl = webUrl(row.url);
  }
  requestSignal.throwIfAborted();
  return { url, reader: "exa", access, ...(accessFallback ? { accessFallback } : {}), sourceUrl, ...freshness, ...excerpt("exa", text, limit), notes: REMOTE_NOTES };
}

/** Firecrawl scrape renders JavaScript, which helps with pages ax and Exa cannot read. */
export async function readFirecrawlPage(input: ReadInput, signal?: AbortSignal, env: Env = process.env, request: Fetch = fetch, deadlineAt = performance.now() + READ_TIMEOUT_MS): Promise<PageResult> {
  const url = webUrl(input.url);
  const limit = excerptBudget(input, "firecrawl");
  const key = env.FIRECRAWL_API_KEY?.trim();
  if (!key) throw new Error("Configure FIRECRAWL_API_KEY to read with Firecrawl. No request was sent.");
  const requestSignal = readSignal(signal, deadlineAt);
  requestSignal.throwIfAborted();
  const timeout = Math.max(1000, Math.floor(deadlineAt - performance.now()) - 1000);
  const response = await request("https://api.firecrawl.dev/v2/scrape", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, timeout }), signal: requestSignal, redirect: "error" });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Firecrawl page reading failed (HTTP ${response.status}).`); }
  const raw = await boundedJson(response) as { success?: boolean; data?: { markdown?: unknown; metadata?: { sourceURL?: unknown; url?: unknown } } };
  const markdown = raw?.data?.markdown;
  if (raw?.success === false || typeof markdown !== "string") throw new Error("Firecrawl returned no readable content for this URL.");
  requestSignal.throwIfAborted();
  let sourceUrl: string | undefined;
  try { const reported = raw.data?.metadata?.url ?? raw.data?.metadata?.sourceURL; if (typeof reported === "string") sourceUrl = webUrl(reported); } catch { /* unverifiable */ }
  return { url, reader: "firecrawl", access: "api-key", ...(sourceUrl ? { sourceUrl } : {}), ...excerpt("firecrawl", markdown, limit), notes: REMOTE_NOTES };
}

/** Mistral's web_search connector opens HTTP(S) URLs and news article IDs from Mistral search. */
export async function readMistralPage(input: ReadInput, signal?: AbortSignal, env: Env = process.env, request: Fetch = fetch, deadlineAt = performance.now() + READ_TIMEOUT_MS, baseUrl?: string): Promise<PageResult> {
  const article = ARTICLE_ID.test(input.url.trim());
  const target = article ? input.url.trim() : webUrl(input.url);
  const limit = excerptBudget(input, "mistral");
  const apiKey = env.MISTRAL_API_KEY?.trim();
  if (!apiKey) throw new Error("Configure Pi's mistral provider or MISTRAL_API_KEY to read with Mistral. No request was sent.");
  const requestSignal = readSignal(signal, deadlineAt);
  requestSignal.throwIfAborted();
  const page = await openMistral(target, { apiKey, baseUrl, deadline: deadlineAt }, requestSignal, request);
  requestSignal.throwIfAborted();
  let sourceUrl: string | undefined;
  try { if (page.url && page.url !== target) sourceUrl = webUrl(page.url); } catch { /* article IDs echo back */ }
  return { url: target, reader: "mistral", access: "api-key", ...(sourceUrl ? { sourceUrl } : {}), ...excerpt("mistral", page.text, limit), notes: REMOTE_NOTES };
}

export interface RemoteContext { env: Env; request: Fetch; mistralBaseUrl?: string }
export type RemotePageReader = (input: ReadInput, signal: AbortSignal | undefined, deadline: number, context: RemoteContext) => Promise<PageResult>;
export const REMOTE_READERS: Record<RemoteReader, RemotePageReader> = {
  exa: (input, signal, deadline, { env, request }) => readExaPage(input, signal, env, request, deadline),
  firecrawl: (input, signal, deadline, { env, request }) => readFirecrawlPage(input, signal, env, request, deadline),
  mistral: (input, signal, deadline, { env, request, mistralBaseUrl }) => readMistralPage(input, signal, env, request, deadline, mistralBaseUrl),
};

/** Exa, then configured Firecrawl and Mistral; `PI_WEB_OPEN_PROVIDER` moves one reader first. */
export function remoteOrder(env: Env): RemoteReader[] {
  const available = (reader: RemoteReader) => reader === "exa" || !!env[reader === "firecrawl" ? "FIRECRAWL_API_KEY" : "MISTRAL_API_KEY"]?.trim();
  const preferred = env.PI_WEB_OPEN_PROVIDER?.trim().toLowerCase();
  const order: RemoteReader[] = ["exa", "firecrawl", "mistral"];
  return [...order.filter((reader) => reader === preferred), ...order.filter((reader) => reader !== preferred)].filter(available);
}

/** Short failure cause for the route: an HTTP status or the provider's own summary, never raw remote text. */
export function readFailureReason(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && error.name === "TimeoutError") return "timed out";
  const message = error instanceof Error ? error.message : "";
  const status = message.match(/\bHTTP ([1-5]\d{2})\b/)?.[1];
  if (status) return `HTTP ${status}`;
  if (/access challenge|blocked/.test(message)) return "access challenge";
  if (/no readable content/.test(message)) return "no readable content";
  return "request failed";
}

/**
 * Tries remote readers in order under the caller's deadline. Invalid input stops the route;
 * cancellation propagates. Returns the first readable excerpt with the attempts so far.
 */
export async function readRemoteChain(input: ReadInput, order: readonly RemoteReader[], signal: AbortSignal | undefined, deadline: number, context: RemoteContext, readers = REMOTE_READERS, attempts: ReadAttempt[] = []): Promise<PageResult> {
  for (const reader of order) {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) break;
    try {
      const result = await readers[reader](input, signal, deadline, context);
      signal?.throwIfAborted();
      return { ...result, route: [...attempts, { reader, outcome: "succeeded" }] };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.message.includes("No request was sent") && order.length === 1) throw error;
      attempts.push({ reader, outcome: "failed", reason: readFailureReason(error) });
    }
  }
  throw new Error(`Remote reading failed: ${attempts.map((attempt) => `${NAMES[attempt.reader as RemoteReader] ?? attempt.reader} (${attempt.reason})`).join(" → ") || "no reader available"}. No provider or access mode was changed. Try again later or inspect the original source.`);
}
