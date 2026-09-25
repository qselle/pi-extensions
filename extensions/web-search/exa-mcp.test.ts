import { expect, test } from "bun:test";
import { formatSearch, searchWeb, type Fetch } from "./client.ts";

const rpc = (result: unknown, id = 2, headers?: Record<string, string>) => Response.json({ jsonrpc: "2.0", id, result }, { headers });
const initialized = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
const payload = (results: unknown[] = []) => ({ content: [{ type: "text", text: JSON.stringify({ results }) }] });
function server(options: { call?: (init: RequestInit) => Response | Promise<Response>; initialize?: () => Response; session?: boolean } = {}) {
  const calls: { url: string; init: RequestInit; message: any }[] = [];
  const request: Fetch = async (url, init = {}) => {
    const message = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, init, message });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (message.method === "initialize") return options.initialize?.() ?? rpc(initialized, 1, options.session === false ? {} : { "mcp-session-id": "fixture-session" });
    if (message.method.startsWith("notifications/")) return new Response(null, { status: 202 });
    expect(message.method).toBe("tools/call");
    return options.call?.(init) ?? rpc(payload());
  };
  return { request, calls };
}

test("default keyless Exa negotiates MCP and preserves filtering, bounds and source attribution", async () => {
  const fixture = server({ call: () => rpc(payload([
    { url: "https://docs.example.com/guide#one", title: "\x1b[31mSource\x1b[0m", highlights: ["x".repeat(2000)] },
    { url: "https://docs.example.com/guide#two" },
    { url: "https://example.com.evil.test/" },
    { url: "https://user:secret@example.com/" },
  ])) });
  const result = await searchWeb({ query: " public query ", domains: [" EXAMPLE.COM "], limit: 2, date_range: { start: "2026-01-01", end: "2026-09-20" } }, undefined, { FIRECRAWL_API_KEY: "unused-secret" }, fixture.request);
  expect(result.access).toBe("keyless");
  expect(result.provider).toBe("exa");
  expect(result.results).toEqual([{ url: "https://docs.example.com/guide#one", title: "Source", snippet: "x".repeat(1200), dateUncertain: true }]);
  expect(result.diagnostics).toEqual({ received: 4, invalid: 1, duplicate: 1, outsideDomains: 1, omitted: 0, outsideDates: 0, uncertainDates: 1 });
  expect(formatSearch(result)).toContain("Access: keyless hosted search");
  expect(formatSearch(result)).toContain("2026-01-01 through 2026-09-20");
  expect(fixture.calls.map(({ init, message }) => message?.method ?? init.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "DELETE"]);
  const search = fixture.calls[2]!;
  expect(search.message.params).toEqual({ name: "web_search_advanced_exa", arguments: {
    query: "public query", numResults: 2, type: "auto", includeDomains: ["example.com"],
    startPublishedDate: "2026-01-01T00:00:00.000Z", endPublishedDate: "2026-09-20T23:59:59.999Z",
    enableHighlights: true, highlightsQuery: "public query", highlightsMaxCharacters: 1200, textMaxCharacters: 1200, enableSummary: false,
  } });
  for (const [index, { url, init }] of fixture.calls.entries()) {
    expect(url).toBe("https://mcp.exa.ai/mcp?tools=web_search_advanced_exa");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-api-key")).toBe(false);
    expect(headers.get("mcp-session-id")).toBe(index ? "fixture-session" : null);
    expect(headers.get("mcp-protocol-version")).toBe(index ? "2025-06-18" : null);
  }
  expect(JSON.stringify(fixture.calls)).not.toContain("unused-secret");
});

test("keyless quota fallback releases the MCP session before using a configured provider", async () => {
  const fixture = server({ call: () => new Response(null, { status: 429, headers: { "retry-after": "10" } }) });
  let alternateCalls = 0;
  const result = await searchWeb({ query: "q" }, undefined, { FIRECRAWL_API_KEY: "fixture-key" }, async (url, init) => {
    if (!url.includes("firecrawl")) return fixture.request(url, init);
    alternateCalls++;
    expect(fixture.calls.at(-1)?.init.method).toBe("DELETE");
    return Response.json({ data: { web: [{ url: "https://example.com/docs", title: "Documentation" }] } });
  });
  expect(alternateCalls).toBe(1);
  expect(result.provider).toBe("firecrawl");
  expect(result.attempts?.[0]).toEqual({ provider: "exa", outcome: "failed", reason: "HTTP 429" });
});

test("balanced and fast work without a session ID; structured and JSON-text results are accepted", async () => {
  for (const quality of ["balanced", "fast"] as const) {
    const fixture = server({ session: false, call: () => rpc(quality === "fast" ? { structuredContent: { results: [] }, content: [] } : payload()) });
    const result = await searchWeb({ query: "q", quality }, undefined, {}, fixture.request);
    expect(result.results).toEqual([]);
    expect(fixture.calls).toHaveLength(3);
    expect(fixture.calls[2]!.message.params.arguments.type).toBe(quality === "fast" ? "fast" : "auto");
    expect(result.searchType).toBe(quality === "fast" ? "fast" : "auto");
  }
});

test("keyless search preserves path case, category and freshness without using configured account keys", async () => {
  const fixture = server({ call: (init) => {
    const args = JSON.parse(String(init.body)).params.arguments;
    expect(args).toMatchObject({ maxAgeHours: 0, category: "news", includeDomains: ["docs.example.com/API"], excludeDomains: ["docs.example.com/API/old"] });
    return rpc(payload([{ url: "https://docs.example.com/API/current" }, { url: "https://docs.example.com/API/old/item" }]));
  } });
  const result = await searchWeb({ query: "q", domains: [" DOCS.EXAMPLE.COM/API "], exclude_domains: ["docs.example.com/API/old"], category: "news", max_age_hours: 0 }, undefined, {}, fixture.request);
  expect(result.access).toBe("keyless");
  expect(result.maxAgeHours).toBe(0);
  expect(result.category).toBe("news");
  expect(result.results.map((row) => row.url)).toEqual(["https://docs.example.com/API/current"]);
  expect(fixture.calls.some(({ init }) => new Headers(init.headers).has("x-api-key"))).toBe(false);
});

test("explicit account access selects the direct API and never falls back to anonymous search on failure", async () => {
  for (const status of [200, 401, 429]) {
    const requests: string[] = [];
    const pending = searchWeb({ query: "q" }, undefined, { EXA_API_KEY: "optional-key" }, async (url, init) => {
      requests.push(url);
      expect(new Headers(init?.headers).get("x-api-key")).toBe("optional-key");
      return status === 200 ? Response.json({ results: [] }) : new Response("hidden error", { status });
    });
    if (status === 200) expect((await pending).access).toBe("api-key");
    else await expect(pending).rejects.toThrow(`HTTP ${status}`);
    expect(requests).toEqual(Array(status === 429 ? 2 : 1).fill("https://api.exa.ai/search"));
  }
});

test("SSE tolerates fragmented UTF-8, CRLF, multiline data and notifications, then closes after the matching reply", async () => {
  let closed = false;
  const content = payload([{ url: "https://example.com/", title: "界 café" }]);
  const bytes = new TextEncoder().encode(': keepalive\r\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\r\n\r\n'
    + 'data: {"jsonrpc":"2.0","id":99,"result":{}}\r\n\r\n'
    + 'event: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":2,"result":' + JSON.stringify(content) + '}\r\n\r\n');
  let offset = 0;
  const fixture = server({
    initialize: () => new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: initialized })}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "fixture-session" } }),
    call: () => new Response(new ReadableStream({ pull(controller) { if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset)); }, cancel() { closed = true; } }), { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
  });
  const result = await searchWeb({ query: "q" }, undefined, {}, fixture.request);
  expect(result.results[0]!.title).toBe("界 café");
  expect(closed).toBe(true);
  expect(fixture.calls.at(-1)!.init.method).toBe("DELETE");
});

test("keyless HTTP failures expose actionable status without remote text and with one bounded rate-limit retry", async () => {
  for (const status of [401, 429, 500]) {
    const fixture = server({ call: () => new Response("private-remote-error", { status }) });
    const pending = searchWeb({ query: "q", provider: "exa" }, undefined, { FIRECRAWL_API_KEY: "do-not-use" }, fixture.request);
    await expect(pending).rejects.toThrow(`HTTP ${status}`);
    await expect(pending).rejects.not.toThrow("private-remote-error");
    if (status === 429) await expect(pending).rejects.toThrow("Free access is rate limited");
    expect(fixture.calls.filter((call) => call.message?.method === "tools/call")).toHaveLength(status === 429 ? 2 : 1);
    expect(fixture.calls.at(-1)!.init.method).toBe("DELETE");
  }
});

test("protocol and tool errors, malformed formats and oversized bodies fail instead of inventing empty results", async () => {
  const responses = [
    () => Response.json({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "hidden error" } }),
    () => rpc({ isError: true, content: [{ type: "text", text: "hidden error" }] }),
    () => rpc({ content: [{ type: "text", text: "No sources. https://invented.test" }] }),
    () => rpc({ content: [{ type: "text", text: '{}' }] }),
    () => rpc(payload(), 99),
    () => new Response("hidden error", { headers: { "content-type": "text/html" } }),
    () => new Response("x".repeat(2_000_001), { headers: { "content-type": "application/json" } }),
    () => new Response(": " + "x".repeat(2_000_001), { headers: { "content-type": "text/event-stream" } }),
    () => new Response('data: {"jsonrpc":"2.0","id":3,"method":"sampling/createMessage"}\n\n', { headers: { "content-type": "text/event-stream" } }),
  ];
  for (const call of responses) {
    const fixture = server({ call });
    const pending = searchWeb({ query: "q" }, undefined, {}, fixture.request);
    await expect(pending).rejects.toThrow("Exa keyless search");
    await expect(pending).rejects.not.toThrow("hidden error");
    expect(fixture.calls.filter((call) => call.message?.method === "tools/call")).toHaveLength(1);
    expect(fixture.calls.at(-1)!.init.method).toBe("DELETE");
  }
});

test("invalid handshakes fail before searching and release any assigned session", async () => {
  for (const result of [{ ...initialized, protocolVersion: "unknown" }, { ...initialized, capabilities: {} }]) {
    const fixture = server({ initialize: () => rpc(result, 1, { "mcp-session-id": "fixture-session" }) });
    await expect(searchWeb({ query: "q" }, undefined, {}, fixture.request)).rejects.toThrow("unsupported protocol");
    expect(fixture.calls.map(({ message, init }) => message?.method ?? init.method)).toEqual(["initialize", "DELETE"]);
  }
  const fixture = server({ initialize: () => rpc(initialized, 1, { "mcp-session-id": "invalid session" }) });
  await expect(searchWeb({ query: "q" }, undefined, {}, fixture.request)).rejects.toThrow("invalid session identifier");
  expect(fixture.calls).toHaveLength(1);
});

test("invalid input, unsupported deep mode and pre-cancelled requests never start a keyless session", async () => {
  const fixture = server();
  for (const input of [{ query: " " }, { query: "q", quality: "deep" as const }, { query: "q", domains: ["file:///bad"] }, { query: "q", date_range: { start: "2026-02-30", end: "2026-03-01" } }]) {
    await expect(searchWeb(input, undefined, {}, fixture.request)).rejects.toThrow();
  }
  await expect(searchWeb({ query: "q" }, AbortSignal.abort(), {}, fixture.request)).rejects.toThrow();
  expect(fixture.calls).toHaveLength(0);
});

test("cancellation notifies the pending search and releases its session with a fresh bounded signal", async () => {
  const controller = new AbortController();
  const fixture = server({ call: (init) => { controller.abort(); init.signal!.throwIfAborted(); throw new Error("unreachable"); } });
  await expect(searchWeb({ query: "q" }, controller.signal, {}, fixture.request)).rejects.toThrow();
  expect(fixture.calls.map(({ message, init }) => message?.method ?? init.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "notifications/cancelled", "DELETE"]);
  expect(fixture.calls[3]!.message.params.requestId).toBe(2);
  expect(fixture.calls[3]!.init.signal!.aborted).toBe(false);
  expect(fixture.calls[3]!.init.signal).not.toBe(fixture.calls[2]!.init.signal);
});
