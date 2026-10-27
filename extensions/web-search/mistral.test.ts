import { expect, test } from "bun:test";
import { formatSearch, searchWeb, selectProvider } from "./client.ts";
import { mistralEndpoint, mistralRows } from "./mistral.ts";

const row = (rank: number, url: string | null, extra: Record<string, unknown> = {}) => ({ url, title: `Result ${rank}`, description: "Description", snippets: [`Snippet ${rank}`, `Snippet ${rank}`], date: null, rank, source: "brave", metadata: null, can_open: true, ...extra });
const reply = (results: Record<string, unknown>, id = 1) => Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(results) }], structuredContent: results, isError: false } });

test("Mistral calls the web_search connector once and keeps ranked results with snippets and dates", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const result = await searchWeb({ query: "current query", provider: "mistral", limit: 5, date_range: { start: "2026-01-01", end: "2026-02-01" } }, undefined,
    { MISTRAL_API_KEY: "secret", EXA_API_KEY: "other" }, async (url, init) => {
      calls.push({ url, init: init! });
      return reply({ b: row(1, "https://example.com/second", { date: "2026-01-20" }), a: row(0, "https://example.com/first"), c: row(2, "https://example.com/old", { date: "2025-01-01" }) });
    }, { mistralBaseUrl: "https://api.mistral.ai/v1/" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.mistral.ai/v1/connectors-gateway/web_search/mcp");
  const headers = new Headers(calls[0]!.init.headers);
  expect(headers.get("authorization")).toBe("Bearer secret");
  expect(headers.has("x-api-key")).toBe(false);
  expect(calls[0]!.init.redirect).toBe("error");
  expect(JSON.parse(String(calls[0]!.init.body)).params).toEqual({ name: "web_search", arguments: { query: "current query", limit: 5, start_date: "2026-01-01", end_date: "2026-02-01" } });
  expect(result.results.map((hit) => hit.url)).toEqual(["https://example.com/first", "https://example.com/second"]);
  expect(result.results[1]).toMatchObject({ snippet: "Snippet 1", published: "2026-01-20" });
  expect(result.diagnostics?.outsideDates).toBe(1);
  expect(result.searchType).toBe("web_search");
  expect(formatSearch(result)).not.toContain("citations");
});

test("news articles without URLs are kept by ID, except when domains are required", () => {
  const rows = mistralRows({ AFP123: row(0, null), "bad id!": row(1, null), closed: row(2, null, { can_open: false }) });
  expect(rows).toEqual([expect.objectContaining({ articleId: "AFP123" }), expect.not.objectContaining({ articleId: expect.anything() }), expect.not.objectContaining({ articleId: expect.anything() })]);
  expect(() => mistralRows([])).toThrow("unexpected response");
  expect(mistralEndpoint("https://proxy.test/v1")).toBe("https://proxy.test/v1/connectors-gateway/web_search/mcp");
});

test("article results are listed with an ID the model can open", async () => {
  const result = await searchWeb({ query: "q", provider: "mistral" }, undefined, { MISTRAL_API_KEY: "secret" }, async () => reply({ AFP123: row(0, null, { title: "Wire story" }) }));
  expect(result.results).toEqual([{ articleId: "AFP123", title: "Wire story", snippet: "Snippet 0" }]);
  expect(formatSearch(result)).toContain("Article ID: AFP123 (open with web_read)");
  const scoped = await searchWeb({ query: "q", provider: "mistral", domains: ["example.com"] }, undefined, { MISTRAL_API_KEY: "secret" }, async () => reply({ AFP123: row(0, null) }));
  expect(scoped.results).toEqual([]);
  expect(scoped.diagnostics?.outsideDomains).toBe(1);
});

test("Mistral is opt-in and unsupported controls fail before any request", async () => {
  expect(selectProvider(undefined, { MISTRAL_API_KEY: "secret" })).toBe("exa");
  expect(selectProvider("mistral", { MISTRAL_API_KEY: "secret" })).toBe("mistral");
  let calls = 0;
  for (const extra of [{ quality: "fast" }, { quality: "deep" }, { category: "news" }, { max_age_hours: 0 }]) {
    await expect(searchWeb({ query: "q", provider: "mistral", ...extra } as never, undefined, { MISTRAL_API_KEY: "secret" }, async () => { calls++; return Response.json({}); })).rejects.toThrow("No request was sent");
  }
  await expect(searchWeb({ query: "q", provider: "mistral" }, undefined, {}, async () => { calls++; return Response.json({}); })).rejects.toThrow("MISTRAL_API_KEY");
  expect(calls).toBe(0);
});

test("Mistral failures do not retry or switch providers and never echo remote text", async () => {
  let calls = 0;
  const pending = searchWeb({ query: "q", provider: "mistral" }, undefined, { MISTRAL_API_KEY: "secret", EXA_API_KEY: "other" }, async () => {
    calls++; return new Response("private failure", { status: 429 });
  });
  await expect(pending).rejects.toThrow("Rate limited");
  await expect(pending).rejects.not.toThrow("private failure");
  expect(calls).toBe(1);
});
