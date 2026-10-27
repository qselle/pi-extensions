import type { Fetch } from "./client.ts";
import { requestWithRetry, type RetryPolicy } from "./retry.ts";

const PROTOCOL = "2025-06-18";
const LIMIT = 2_000_000;
type RecordValue = Record<string, unknown>;
export const isRecord = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);

/** Remote text is never copied into errors; only the HTTP status, when known, is kept. */
export class McpError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export interface McpCall {
  endpoint: string;
  tool: string;
  arguments: RecordValue;
  /** Product name for errors, for example "Exa keyless search". */
  label: string;
  /** Appended to rejection errors. */
  hint?: string;
  /** Authentication headers. */
  headers?: Record<string, string>;
  signal: AbortSignal;
  request: Fetch;
  retry: RetryPolicy;
  /** Message for a failed HTTP status; defaults to a generic one. */
  httpError?: (status: number) => string;
}

function parseJson(text: string, label: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new McpError(`${label} returned invalid JSON.`); }
}

type Reply = { result: RecordValue } | { error: unknown };

function reply(value: unknown, id: number, label: string): Reply | undefined {
  if (!isRecord(value) || value.jsonrpc !== "2.0") throw new McpError(`${label} returned an invalid protocol message.`);
  // No sampling, roots or other client capabilities are offered to the server.
  if (typeof value.method === "string") {
    if (value.id !== undefined) throw new McpError(`${label} requested an unsupported client operation.`);
    return undefined;
  }
  if (value.id !== id) return undefined;
  if (value.error !== undefined) return { error: value.error };
  if (!isRecord(value.result)) throw new McpError(`${label} returned an invalid result.`);
  return { result: value.result };
}

/** Read only this request's reply; SSE may stay open after delivering it. */
async function readReply(response: Response, id: number, label: string): Promise<Reply> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
  const reader = response.body?.getReader();
  if (!reader) throw new McpError(`${label} returned an empty response.`);
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = "";
  let data: string[] = [];
  const line = (text: string) => {
    if (text === "") {
      const event = data.join("\n");
      data = [];
      return event ? reply(parseJson(event, label), id, label) : undefined;
    }
    if (text.startsWith("data:")) data.push(text.slice(5).replace(/^ /, ""));
    return undefined;
  };
  try {
    if (contentType !== "application/json" && contentType !== "text/event-stream") throw new McpError(`${label} returned an unsupported response format.`);
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        bytes += value.length;
        if (bytes > LIMIT) throw new McpError(`${label} response exceeded 2 MB.`);
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
        const result = reply(parseJson(buffer, label), id, label);
        if (result) return result;
      }
      if (done) throw new McpError(`${label} ended without the requested result.`);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Tool errors keep only a recognizable account status so callers can switch access. */
function toolResult(result: RecordValue, label: string, hint: string): RecordValue {
  if (!result.isError) return result;
  const text = Array.isArray(result.content) ? result.content.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join(" ") : "";
  const status = Number(text.match(/\b(401|402|403|429)\b/)?.[1]) || undefined;
  throw new McpError(`${label} reported a tool error${status ? ` (HTTP ${status})` : ""}.${hint}`, status);
}

/** Servers that require a session reject sessionless calls with these statuses or a session error. */
const needsSession = (status: number) => [400, 404, 405, 406].includes(status);
const sessionError = (error: unknown) => isRecord(error) && typeof error.message === "string" && /session|initiali[sz]/i.test(error.message);

/**
 * Calls one fixed tool. A single stateless `tools/call` POST is tried first; when the server
 * rejects it for lack of a session, the full initialize handshake runs once. No server-initiated
 * client operations are supported.
 */
export async function callMcpTool(call: McpCall): Promise<RecordValue> {
  const { endpoint, label, signal, request } = call;
  const hint = call.hint ? ` ${call.hint}` : "";
  const httpError = call.httpError ?? ((status: number) => `${label} failed (HTTP ${status}).${hint}`);
  const headers: Record<string, string> = { ...call.headers, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const params = { name: call.tool, arguments: call.arguments };
  signal.throwIfAborted();
  const send = (body: RecordValue, extra: Record<string, string> = {}) =>
    requestWithRetry(request, endpoint, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify({ jsonrpc: "2.0", ...body }), redirect: "error", signal }, call.retry);

  const stateless = await send({ id: 1, method: "tools/call", params }, { "mcp-protocol-version": PROTOCOL });
  if (stateless.ok) {
    const answer = await readReply(stateless, 1, label);
    if ("result" in answer) { signal.throwIfAborted(); return toolResult(answer.result, label, hint); }
    if (!sessionError(answer.error)) throw new McpError(`${label} rejected the request.${hint}`);
  } else {
    await stateless.body?.cancel();
    if (!needsSession(stateless.status)) throw new McpError(httpError(stateless.status), stateless.status);
  }
  return callWithSession(call, headers, params, hint, httpError);
}

async function callWithSession(call: McpCall, headers: Record<string, string>, params: RecordValue, hint: string, httpError: (status: number) => string): Promise<RecordValue> {
  const { endpoint, label, signal, request } = call;
  let session: string | undefined;
  let pending = false;
  const post = async (message: RecordValue, id?: number) => {
    signal.throwIfAborted();
    const response = await requestWithRetry(request, endpoint, { method: "POST", headers: { ...headers }, body: JSON.stringify({ jsonrpc: "2.0", ...message }), redirect: "error", signal }, call.retry);
    if (!response.ok) {
      await response.body?.cancel();
      throw new McpError(httpError(response.status), response.status);
    }
    if (message.method === "initialize") {
      const assigned = response.headers.get("mcp-session-id");
      if (assigned !== null) {
        if (!/^[\x21-\x7e]{1,1024}$/.test(assigned)) {
          await response.body?.cancel();
          throw new McpError(`${label} returned an invalid session identifier.`);
        }
        session = assigned;
        headers["mcp-session-id"] = session;
      }
    }
    if (id === undefined) {
      await response.body?.cancel();
      if (response.status !== 202) throw new McpError(`${label} did not acknowledge initialization.`);
      return undefined;
    }
    const answer = await readReply(response, id, label);
    if ("error" in answer) throw new McpError(`${label} rejected the request.${hint}`);
    return answer.result;
  };
  try {
    const initialized = await post({ id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "pi-extensions", version: "0.1.0" } } }, 1);
    if (initialized?.protocolVersion !== PROTOCOL || !isRecord(initialized.capabilities) || !isRecord(initialized.capabilities.tools)) throw new McpError(`${label} negotiated an unsupported protocol or lacks tools.`);
    headers["mcp-protocol-version"] = PROTOCOL;
    await post({ method: "notifications/initialized" });
    signal.throwIfAborted();
    pending = true;
    const result = await post({ id: 2, method: "tools/call", params }, 2);
    pending = false;
    signal.throwIfAborted();
    return toolResult(result!, label, hint);
  } finally {
    // Cleanup gets its own short deadline after cancellation. Never retry a call
    // or restart an expired session during cleanup.
    const cleanupSignal = AbortSignal.timeout(1500);
    const cleanup = async (init: RequestInit) => {
      try { const response = await request(endpoint, { ...init, headers: { ...headers }, redirect: "error", signal: cleanupSignal }); await response.body?.cancel(); } catch { /* best effort */ }
    };
    if (pending && signal.aborted) await cleanup({ method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "Request cancelled" } }) });
    if (session) await cleanup({ method: "DELETE" });
  }
}

/** Text of `content` blocks, or undefined when any block is not text. */
export function textBlocks(result: RecordValue): string[] | undefined {
  const blocks = result.content;
  if (!Array.isArray(blocks) || blocks.some((block) => !isRecord(block) || block.type !== "text" || typeof block.text !== "string")) return undefined;
  return blocks.map((block) => (block as { text: string }).text);
}

export function parseMcpJson(text: string, label: string): unknown { return parseJson(text, label); }
