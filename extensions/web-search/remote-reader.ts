import { exaAccess } from "./access.ts";
import { boundedJson, webUrl, type Fetch } from "./client.ts";
import { callExaKeyless } from "./exa-mcp.ts";
import { requestWithRetry } from "./retry.ts";
import type { PageResult, ReadInput } from "./reader.ts";
import { PlainOutput } from "../../lib/output.ts";
import { freshnessOptions } from "./filters.ts";
import { pageContentFailure } from "./page-content.ts";

/** Explicit remote fallback: never uploads local files and never switches access policy. */
export async function readExaPage(input: ReadInput, signal?: AbortSignal, env: Record<string, string | undefined> = process.env, request: Fetch = fetch): Promise<PageResult> {
  const url = webUrl(input.url);
  if ((input.mode !== undefined && input.mode !== "markdown") || input.selector !== undefined || (input.offset !== undefined && input.offset !== 0)) throw new Error("Exa reading supports a bounded excerpt only; selectors, outlines and continuation require ax. No request was sent.");
  const budget = input.budget ?? 2000;
  if (!Number.isInteger(budget) || budget < 100 || budget > 8000) throw new Error("Budget must be between 100 and 8000 tokens.");
  const access = exaAccess(env);
  const freshness = freshnessOptions(input.max_age_hours);
  if (input.max_age_hours !== undefined && access === "keyless") throw new Error("Keyless Exa page reading does not expose freshness controls. Use ax for a direct fetch, or configure PI_EXA_ACCESS=api-key and EXA_API_KEY. No request was sent.");
  const deadline = AbortSignal.timeout(30_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  requestSignal.throwIfAborted();
  const limit = Math.min(40_000, budget * 4);
  let text: string;
  let sourceUrl: string | undefined;
  if (access === "keyless") {
    const result = await callExaKeyless("web_fetch_exa", { urls: [url], maxCharacters: limit }, requestSignal, request);
    const blocks = result.content;
    if (!Array.isArray(blocks) || !blocks.length || blocks.some((block) => block?.type !== "text" || typeof block.text !== "string")) throw new Error("Exa returned an unsupported page response.");
    text = blocks.map((block) => block.text).join("\n\n");
    // MCP supplies prose, not structured redirect metadata. Do not promote a
    // URL inside untrusted page text to a verified final URL.
  } else {
    const response = await requestWithRetry(request, "https://api.exa.ai/contents", { method: "POST", headers: { "content-type": "application/json", "x-api-key": env.EXA_API_KEY!.trim() }, body: JSON.stringify({ urls: [url], text: { maxCharacters: limit }, ...freshness }), signal: requestSignal, redirect: "error" }, false);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Exa page reading failed (HTTP ${response.status}). No access mode was changed.`); }
    const raw = await boundedJson(response) as { results?: { text?: unknown; url?: unknown }[] };
    const row = raw?.results?.[0];
    if (!row || typeof row.text !== "string" || !row.text.trim()) throw new Error("Exa returned no readable content for this URL.");
    text = row.text;
    if (typeof row.url === "string") sourceUrl = webUrl(row.url);
  }
  requestSignal.throwIfAborted();
  const cleaned = new PlainOutput().push(text);
  const failure = pageContentFailure(cleaned);
  if (failure) throw new Error(`Exa ${failure}. Try another source or a direct local read.`);
  return { url, reader: "exa", access, sourceUrl, ...freshness, text: cleaned.slice(0, limit), truncated: cleaned.length >= limit,
    notes: "Remote extraction follows the provider's cache policy; freshness is not independently verified. PDF text, tables and figures can be incomplete. The returned excerpt has no continuation token; verify quotations against the original." };
}
