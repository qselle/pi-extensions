import type { Fetch } from "./client.ts";

import { requestWithRetry } from "./retry.ts";
const ENDPOINT = "https://mcp.exa.ai/mcp?tools=";
const PROTOCOL = "2025-06-18";
const LIMIT = 2_000_000;
const RETRY_HINT = "Try again later, or set EXA_API_KEY for API access. No provider or access mode was changed.";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);

function parseJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error("Exa keyless search returned invalid JSON."); }
}

function reply(value: unknown, id: number): RecordValue | undefined {
  if (!record(value) || value.jsonrpc !== "2.0") throw new Error("Exa keyless search returned an invalid protocol message.");
  // No sampling, roots or other client capabilities are offered to the server.
  if (typeof value.method === "string") {
    if (value.id !== undefined) throw new Error("Exa keyless search requested an unsupported client operation.");
    return undefined;
  }
  if (value.id !== id) return undefined;
  if (value.error !== undefined) throw new Error(`Exa keyless search rejected the request. ${RETRY_HINT}`);
  if (!record(value.result)) throw new Error("Exa keyless search returned an invalid result.");
  return value.result;
}

/** Read only this request's result; SSE may stay open after delivering it. */
async function readReply(response: Response, id: number): Promise<RecordValue> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Exa keyless search returned an empty response.");
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = "";
  let data: string[] = [];
  const line = (text: string) => {
    if (text === "") {
      const event = data.join("\n");
      data = [];
      return event ? reply(parseJson(event), id) : undefined;
    }
    if (text.startsWith("data:")) data.push(text.slice(5).replace(/^ /, ""));
    return undefined;
  };
  try {
    if (contentType !== "application/json" && contentType !== "text/event-stream") throw new Error("Exa keyless search returned an unsupported response format.");
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        bytes += value.length;
        if (bytes > LIMIT) throw new Error("Exa keyless search response exceeded 2 MB.");
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += decoder.decode();
      if (contentType === "text/event-stream") {
        // Retain a trailing CR until the next chunk so split CRLF is one delimiter.
        if (done) buffer += "\n\n";
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r\n|\n|\r(?!$)/.exec(buffer))) {
          const result = line(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary[0].length);
          if (result) return result;
        }
      } else if (done) {
        const result = reply(parseJson(buffer), id);
        if (result) return result;
      }
      if (done) throw new Error("Exa keyless search ended without the requested result.");
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

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

export async function searchExaKeyless(input: ExaMcpInput, signal: AbortSignal, request: Fetch): Promise<unknown> {
  const result = await callExaKeyless("web_search_advanced_exa", { ...input, enableHighlights: true, highlightsQuery: input.query, highlightsMaxCharacters: 1200, textMaxCharacters: 1200, enableSummary: false }, signal, request);
  if (record(result.structuredContent) && Array.isArray(result.structuredContent.results)) return result.structuredContent;
  if (Array.isArray(result.content) && result.content.length === 1) {
    const part = result.content[0];
    if (record(part) && part.type === "text" && typeof part.text === "string") {
      const parsed = parseJson(part.text);
      if (record(parsed) && Array.isArray(parsed.results)) return parsed;
    }
  }
  throw new Error("Exa keyless search returned an unexpected search response.");
}

/** Only fixed, read-only tools; no server-initiated client operations or provider switching. */
export async function callExaKeyless(tool: "web_search_advanced_exa" | "web_fetch_exa", input: RecordValue, signal: AbortSignal, request: Fetch): Promise<RecordValue> {
  const endpoint = ENDPOINT + tool;
  signal.throwIfAborted();
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  let session: string | undefined;
  let pendingSearch = false;
  const post = async (message: RecordValue, id?: number) => {
    signal.throwIfAborted();
    const response = await requestWithRetry(request, endpoint, { method: "POST", headers: { ...headers }, body: JSON.stringify({ jsonrpc: "2.0", ...message }), redirect: "error", signal }, true);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Exa keyless search failed (HTTP ${response.status}). ${response.status === 429 ? "Free access is rate limited. " : ""}${RETRY_HINT}`);
    }
    if (message.method === "initialize") {
      const assigned = response.headers.get("mcp-session-id");
      if (assigned !== null) {
        if (!/^[\x21-\x7e]{1,1024}$/.test(assigned)) {
          await response.body?.cancel();
          throw new Error("Exa keyless search returned an invalid session identifier.");
        }
        session = assigned;
        headers["mcp-session-id"] = session;
      }
    }
    if (id === undefined) {
      await response.body?.cancel();
      if (response.status !== 202) throw new Error("Exa keyless search did not acknowledge initialization.");
      return undefined;
    }
    return readReply(response, id);
  };
  try {
    const initialized = await post({ id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "pi-extensions", version: "0.1.0" } } }, 1);
    if (initialized?.protocolVersion !== PROTOCOL || !record(initialized.capabilities) || !record(initialized.capabilities.tools)) throw new Error("Exa keyless search negotiated an unsupported protocol or lacks search tools.");
    headers["mcp-protocol-version"] = PROTOCOL;
    await post({ method: "notifications/initialized" });
    signal.throwIfAborted();
    pendingSearch = true;
    const result = await post({ id: 2, method: "tools/call", params: { name: tool, arguments: input } }, 2);
    pendingSearch = false;
    signal.throwIfAborted();
    if (result?.isError) throw new Error(`Exa keyless search reported a tool error. ${RETRY_HINT}`);
    return result!;
  } finally {
    // Cleanup gets its own short deadline after cancellation. Never retry a search
    // or restart an expired session during cleanup.
    const cleanupSignal = AbortSignal.timeout(1500);
    const cleanup = async (init: RequestInit) => {
      try { const response = await request(endpoint, { ...init, headers: { ...headers }, redirect: "error", signal: cleanupSignal }); await response.body?.cancel(); } catch { /* best effort */ }
    };
    if (pendingSearch && signal.aborted) await cleanup({ method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "Search cancelled" } }) });
    if (session) await cleanup({ method: "DELETE" });
  }
}
