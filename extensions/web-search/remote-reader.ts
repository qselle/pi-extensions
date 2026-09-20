import { exaAccess } from "./access.ts";
import { boundedJson, webUrl, type Fetch } from "./client.ts";
import { callExaKeyless } from "./exa-mcp.ts";
import { requestWithRetry } from "./retry.ts";
import type { PageResult, ReadInput } from "./reader.ts";
import { PlainOutput } from "../../lib/output.ts";

/** Explicit remote fallback: never uploads local files and never switches access policy. */
export async function readExaPage(input: ReadInput, signal?: AbortSignal, env: Record<string, string | undefined> = process.env, request: Fetch = fetch): Promise<PageResult> {
  const url = webUrl(input.url);
  if ((input.mode && input.mode !== "markdown") || input.selector || input.offset) throw new Error("Exa reading supports a bounded excerpt only; selectors, outlines and continuation require ax. No request was sent.");
  const budget = input.budget ?? 2000;
  if (!Number.isInteger(budget) || budget < 100 || budget > 8000) throw new Error("Budget must be between 100 and 8000 tokens.");
  const access = exaAccess(env);
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
    const response = await requestWithRetry(request, "https://api.exa.ai/contents", { method: "POST", headers: { "content-type": "application/json", "x-api-key": env.EXA_API_KEY!.trim() }, body: JSON.stringify({ urls: [url], text: { maxCharacters: limit } }), signal: requestSignal, redirect: "error" }, false);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Exa page reading failed (HTTP ${response.status}). No access mode was changed.`); }
    const raw = await boundedJson(response) as { results?: { text?: unknown; url?: unknown }[] };
    const row = raw?.results?.[0];
    if (!row || typeof row.text !== "string" || !row.text.trim()) throw new Error("Exa returned no readable content for this URL.");
    text = row.text;
    if (typeof row.url === "string") sourceUrl = webUrl(row.url);
  }
  requestSignal.throwIfAborted();
  return { url, reader: "exa", access, sourceUrl, text: new PlainOutput().push(text).slice(0, limit), truncated: text.length > limit,
    notes: "Remote extraction may use cached content. PDF text, tables and figures can be incomplete. The returned excerpt has no continuation token; verify quotations against the original." };
}
