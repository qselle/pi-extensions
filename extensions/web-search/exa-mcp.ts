import type { Fetch } from "./client.ts";
import { callMcpTool, isRecord, parseMcpJson } from "./mcp.ts";

const ENDPOINT = "https://mcp.exa.ai/mcp?tools=";
const LABEL = "Exa keyless search";
const RETRY_HINT = "Try again later, or set EXA_API_KEY for API access. No provider or access mode was changed.";

export interface ExaMcpInput {
  query: string;
  numResults: number;
  type: "auto" | "fast";
  includeDomains?: string[];
  excludeDomains?: string[];
  category?: string;
  startPublishedDate?: string;
  endPublishedDate?: string;
  maxAgeHours?: number;
}

export interface KeylessOptions {
  deadline: number;
  /** Leave HTTP 429 to the caller, which switches to the API key instead of waiting. */
  paidFallback?: boolean;
}

export async function searchExaKeyless(input: ExaMcpInput, signal: AbortSignal, request: Fetch, options: KeylessOptions): Promise<unknown> {
  const result = await callExaKeyless("web_search_advanced_exa", { ...input, enableHighlights: true, highlightsQuery: input.query, highlightsMaxCharacters: 1200, textMaxCharacters: 1200, enableSummary: false }, signal, request, options);
  if (isRecord(result.structuredContent) && Array.isArray(result.structuredContent.results)) return result.structuredContent;
  if (Array.isArray(result.content) && result.content.length === 1) {
    const part = result.content[0];
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      const parsed = parseMcpJson(part.text, LABEL);
      if (isRecord(parsed) && Array.isArray(parsed.results)) return parsed;
    }
  }
  throw new Error("Exa keyless search returned an unexpected search response.");
}

/** Only fixed, read-only tools; no server-initiated client operations or provider switching. */
export function callExaKeyless(tool: "web_search_advanced_exa" | "web_fetch_exa", input: Record<string, unknown>, signal: AbortSignal, request: Fetch, options: KeylessOptions) {
  return callMcpTool({
    endpoint: ENDPOINT + tool, tool, arguments: input, label: LABEL, hint: RETRY_HINT, signal, request,
    retry: { deadline: options.deadline, rateLimit: !options.paidFallback, serverErrors: true },
    httpError: (status) => `Exa keyless search failed (HTTP ${status}). ${status === 429 ? "Free access is rate limited. " : ""}${RETRY_HINT}`,
  });
}
