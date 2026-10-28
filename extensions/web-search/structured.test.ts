import { afterEach, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { formatSearch, type SearchResult } from "./client.ts";
import extension from "./index.ts";
import { formatPage, type PageResult } from "./reader.ts";
import { pageStructured, READ_OUTPUT_SCHEMA, SEARCH_OUTPUT_SCHEMA } from "./structured.ts";

const KEYS = { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "exa-fixture", FIRECRAWL_API_KEY: "firecrawl-fixture", MISTRAL_API_KEY: undefined, PI_WEB_SEARCH_PROVIDER: undefined, PI_WEB_OPEN_PROVIDER: undefined };
const saved = Object.fromEntries(Object.keys(KEYS).map((key) => [key, process.env[key]]));
const savedFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});

function tools(fetch: (url: string, init?: RequestInit) => Promise<Response>) {
  for (const [key, value] of Object.entries(KEYS)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  globalThis.fetch = fetch as typeof globalThis.fetch;
  const registered = new Map<string, any>();
  extension({ registerTool: (tool: any) => registered.set(tool.name, tool), registerCommand() {} } as never);
  return registered;
}

test("web_search returns ranked structured hits and its route without changing the model text", async () => {
  const registered = tools(async (url) => url.includes("exa.ai")
    ? new Response(null, { status: 429, headers: { "retry-after": "60" } })
    : Response.json({ data: { web: [{ title: "Docs", url: "https://example.com/docs", description: "Reference" }] }, warning: "Partial index" }));
  const search = registered.get("web_search");
  expect(search.outputSchema).toBe(SEARCH_OUTPUT_SCHEMA);
  const value = await search.execute("call", { query: "documentation" }, undefined, undefined, {});
  expect(value.structuredContent).toEqual({
    provider: "firecrawl", query: "documentation",
    results: [{ rank: 1, title: "Docs", url: "https://example.com/docs", snippet: "Reference" }],
    route: [{ provider: "exa", outcome: "failed", reason: "HTTP 429" }, { provider: "firecrawl", outcome: "succeeded" }],
    warning: "Partial index",
  });
  expect(Value.Check(SEARCH_OUTPUT_SCHEMA, value.structuredContent)).toBe(true);
  expect(value.content).toEqual([{ type: "text", text: formatSearch(value.details as SearchResult) }]);
  expect(value.isError).toBeUndefined();
});

test("failed web calls reject instead of returning partial structured data", async () => {
  let calls = 0;
  const registered = tools(async () => { calls++; return new Response(null, { status: 503 }); });
  await expect(registered.get("web_search").execute("call", { query: "q", provider: "firecrawl" }, undefined, undefined, {})).rejects.toThrow("HTTP 503");
  await expect(registered.get("web_read").execute("call", { url: "https://example.com", selector: "main" }, undefined, undefined, {})).rejects.toThrow("No request was sent");
  expect(calls).toBe(1);
});

test("web_read returns page text and continuation as structured fields", async () => {
  const registered = tools(async () => Response.json({ success: true, data: { markdown: "# Title\n\nBody", metadata: { url: "https://example.com/final" } } }));
  const read = registered.get("web_read");
  expect(read.outputSchema).toBe(READ_OUTPUT_SCHEMA);
  const value = await read.execute("call", { url: "https://example.com", reader: "firecrawl" }, undefined, undefined, {});
  expect(value.structuredContent).toEqual({ url: "https://example.com/", reader: "firecrawl", content: "# Title\n\nBody", truncated: false, source_url: "https://example.com/final" });
  expect(Value.Check(READ_OUTPUT_SCHEMA, value.structuredContent)).toBe(true);
  expect(value.content[0].text).toStartWith("Page requested: https://example.com/\nReader: firecrawl (api-key)");

  const page: PageResult = { url: "https://example.com/", reader: "ax", text: "row", notes: "", truncated: false, pagination: { state: "more", nextOffset: 20 } };
  expect(pageStructured(page)).toEqual({ url: page.url, reader: "ax", content: "row", truncated: false, selection: "more", next_offset: 20 });
  expect(formatPage(page)).toContain("Continue with offset 20");
  expect(pageStructured({ ...page, pagination: { state: "complete", nextOffset: null } })).toEqual({ url: page.url, reader: "ax", content: "row", truncated: false, selection: "complete" });
});
