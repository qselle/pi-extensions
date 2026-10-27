import type { Fetch } from "./client.ts";
import { callMcpTool, isRecord, parseMcpJson, textBlocks } from "./mcp.ts";

export const DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai";
const LABEL = "Mistral web search";

/** The built-in `web_search` connector: ranked results with snippets, and `open_url`. */
export function mistralEndpoint(baseUrl = DEFAULT_MISTRAL_BASE_URL): string {
  const root = baseUrl.trim().replace(/\/+$/, "").replace(/\/v\d+$/i, "");
  return `${root}/v1/connectors-gateway/web_search/mcp`;
}

export interface MistralAccess { apiKey: string; baseUrl?: string; deadline: number }

function call(tool: "web_search" | "open_url", args: Record<string, unknown>, access: MistralAccess, signal: AbortSignal, request: Fetch) {
  return callMcpTool({
    endpoint: mistralEndpoint(access.baseUrl), tool, arguments: args, label: LABEL, signal, request,
    headers: { authorization: `Bearer ${access.apiKey}` },
    retry: { deadline: access.deadline, rateLimit: false },
    httpError: (status) => `mistral search failed (HTTP ${status}). ${status === 401 || status === 403 ? "Check the mistral provider key." : status === 429 ? "Rate limited; try again later." : "Try again later or choose another provider."}`,
  });
}

export function mistralSearchArguments(query: string, limit: number, range?: { start?: string; end?: string }) {
  return { query, limit, ...(range?.start ? { start_date: range.start } : {}), ...(range?.end ? { end_date: range.end } : {}) };
}

export async function searchMistral(args: ReturnType<typeof mistralSearchArguments>, access: MistralAccess, signal: AbortSignal, request: Fetch): Promise<unknown> {
  const result = await call("web_search", args, access, signal, request);
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const text = textBlocks(result);
  if (!text?.length) throw new Error("mistral returned an unexpected response.");
  return parseMcpJson(text.join("\n"), LABEL);
}

/** Rows keyed by result ID, in rank order, mapped to the shared row shape. */
export function mistralRows(raw: unknown): unknown[] {
  if (!isRecord(raw)) throw new Error("mistral returned an unexpected response.");
  return Object.entries(raw)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .sort(([, a], [, b]) => (typeof a.rank === "number" ? a.rank : Infinity) - (typeof b.rank === "number" ? b.rank : Infinity))
    .map(([id, row]) => ({
      url: row.url, title: row.title, description: row.description, publishedDate: row.date,
      highlights: Array.isArray(row.snippets) ? row.snippets : [],
      // News results can have no URL; their ID opens them with open_url.
      ...(row.url == null && row.can_open !== false && /^[\w-]{1,128}$/.test(id) ? { articleId: id } : {}),
    }));
}

/** Opens an HTTP(S) URL or a news article ID returned by Mistral search. */
export async function openMistral(target: string, access: MistralAccess, signal: AbortSignal, request: Fetch): Promise<{ text: string; url?: string }> {
  const result = await call("open_url", { url: target }, access, signal, request);
  const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined;
  if (typeof structured?.content === "string") return { text: structured.content, ...(typeof structured.url === "string" ? { url: structured.url } : {}) };
  const text = textBlocks(result)?.join("\n").trim();
  if (text === undefined) throw new Error("Mistral returned an unsupported page response.");
  // Some responses wrap text parts in a JSON array.
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return { text: parsed.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("\n") };
  } catch { /* plain text */ }
  return { text };
}

/** Mistral reports blocked or failed opens as page text. */
export function mistralOpenFailure(text: string): string | undefined {
  const match = /^\s*(?:Open (blocked|failed):|(Timed out while opening this page))/i.exec(text);
  return match ? (match[1]?.toLowerCase() === "blocked" ? "reported that the page is blocked" : "could not open the page") : undefined;
}
