import { expect, test } from "bun:test";
import { cleanText, formatSearch, normalizeResults, searchRequest, searchWeb, selectProvider, webUrl } from "./client.ts";

test("Exa is the default even without keys; other providers require explicit selection and keys", async () => {
  expect(selectProvider(undefined, { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "x", FIRECRAWL_API_KEY: "y" })).toBe("exa");
  expect(selectProvider(undefined, { FIRECRAWL_API_KEY: "y" })).toBe("exa");
  expect(selectProvider("exa", {})).toBe("exa");
  expect(selectProvider("firecrawl", { FIRECRAWL_API_KEY: "y" })).toBe("firecrawl");
  let calls = 0;
  await expect(searchWeb({ query: "q", provider: "firecrawl" }, undefined, {}, (() => { calls++; }) as never)).rejects.toThrow("No request was sent");
  expect(calls).toBe(0);
});

test("search validates controls and maps both documented provider contracts", () => {
  expect(searchRequest({ query: " q ", domains: ["EXAMPLE.COM"] }, "exa").body).toEqual({ query: "q", numResults: 5, type: "auto", contents: { highlights: true }, includeDomains: ["example.com"] });
  expect(searchRequest({ query: "q", limit: 2 }, "firecrawl").body).toEqual({ query: "q", limit: 2, sources: ["web"], timeout: 25_000 });
  for (const input of [{ query: " " }, { query: "q", limit: 100 }, { query: "q", domains: ["https://example.com/"] }]) {
    expect(() => searchRequest(input, "exa")).toThrow();
  }
});

test("results preserve attribution, remove controls, deduplicate URLs and cap snippets", () => {
  const rows = [
    { title: "\x1b[31mTitle\x1b[0m\n", url: "https://example.com/#one", highlights: ["x".repeat(2000)] },
    { title: "Duplicate", url: "https://example.com/#two" },
    { title: "Unsafe", url: "javascript:alert(1)" },
    { title: "Credentials", url: "https://secret:secret@example.com" },
    { title: "Second", url: "https://example.org", description: "description" },
  ];
  const hits = normalizeResults({ results: rows }, "exa", 5);
  expect(hits).toHaveLength(2);
  expect(hits[0]!.title).toBe("Title");
  expect(hits[0]!.snippet).toHaveLength(1200);
  expect(normalizeResults({ data: { web: rows } }, "firecrawl", 1)).toHaveLength(1);
  expect(formatSearch({ provider: "exa", query: "q", results: hits })).toContain("https://example.com/#one");
  expect(() => normalizeResults({ success: false }, "firecrawl", 5)).toThrow();
  expect(cleanText("\x1b]0;bad\x07hello")).toBe("hello");
});

test("HTTP request uses expected authentication, cancellation, and no redirects", async () => {
  for (const provider of ["exa", "firecrawl"] as const) {
    let captured: RequestInit | undefined;
    const result = await searchWeb({ query: "q", provider }, undefined, { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "a", FIRECRAWL_API_KEY: "b" }, (async (_url, init) => {
      captured = init;
      return Response.json(provider === "exa" ? { results: [] } : { success: true, data: { web: [] } });
    }) as import("./client.ts").Fetch);
    expect(captured!.redirect).toBe("error");
    expect(captured!.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(captured!.headers).get(provider === "exa" ? "x-api-key" : "Authorization")).toBe(provider === "exa" ? "a" : "Bearer b");
    expect(result.provider).toBe(provider);
  }
});

test("HTTP errors never echo remote bodies or retry billable requests", async () => {
  let calls = 0;
  await expect(searchWeb({ query: "q" }, undefined, { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "private-key" }, (async () => {
    calls++;
    return new Response("private-key", { status: 401 });
  }) as import("./client.ts").Fetch)).rejects.toThrow("Check EXA_API_KEY");
  expect(calls).toBe(1);
});

test("oversized responses fail and pre-cancelled searches never send", async () => {
  await expect(searchWeb({ query: "q" }, undefined, { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "x" }, (async () => new Response("x".repeat(2_000_001))) as import("./client.ts").Fetch)).rejects.toThrow("exceeded 2 MB");
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await expect(searchWeb({ query: "q" }, controller.signal, { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "x" }, (() => { called = true; }) as never)).rejects.toThrow();
  expect(called).toBe(false);
  expect(() => webUrl("file:///etc/passwd")).toThrow();
});

test("domain restrictions are enforced locally with honest exclusion counts", async () => {
  for (const provider of ["exa", "firecrawl"] as const) {
    const rows = [
      { url: "https://example.com.evil.test/" },
      { url: "https://other.test/example.com" },
      { url: "https://notexample.com/" },
      { url: "https://docs.example.com/page#one", title: "Docs" },
      { url: "https://docs.example.com/page#two", title: "Duplicate" },
      { url: "https://EXAMPLE.COM./guide", title: "Root" },
      { url: "https://example.com/more" },
      { url: "javascript:bad()" },
      null,
    ];
    const result = await searchWeb({ query: "q", provider, limit: 2, domains: [" EXAMPLE.COM "] }, undefined,
      { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "x", FIRECRAWL_API_KEY: "y" }, async () => Response.json(provider === "exa" ? { results: rows } : { data: { web: rows } }));
    expect(result.results.map((hit) => hit.title)).toEqual(["Docs", "Root"]);
    expect(result.diagnostics).toEqual({ received: 9, invalid: 2, duplicate: 1, outsideDomains: 3, omitted: 1 });
    expect(formatSearch(result)).toContain("3 outside requested domains");
    expect(formatSearch(result)).toContain("1 beyond result limit");
  }
});

test("empty provider results differ from discarded results without leaking rejected content", async () => {
  for (const rows of [[], [{ url: "https://private:password@example.com" }], [{ url: "https://unrelated.test" }]]) {
    const result = await searchWeb({ query: "q", domains: ["example.com"] }, undefined,
      { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "x" }, async () => Response.json({ results: rows }));
    const text = formatSearch(result);
    expect(text).toContain(rows.length ? "No usable results remain" : "No results found");
    expect(text).not.toContain("password");
    expect(text).not.toContain("unrelated.test");
  }
});

test("successful Firecrawl warnings remain visible without implying exhaustive search", async () => {
  for (const rows of [[], [{ url: "https://example.com/", title: "Retained source" }]]) {
    let calls = 0;
    const result = await searchWeb({ query: "q", provider: "firecrawl" }, undefined, { FIRECRAWL_API_KEY: "x" }, async (_url, init) => {
      calls++;
      expect(JSON.parse(init!.body as string).timeout).toBe(25_000);
      return Response.json({ success: true, data: { web: rows }, warning: "\x1b]0;hidden\x07Some results unavailable.\n" + "x".repeat(600) });
    });
    expect(calls).toBe(1);
    expect(result.warning).toHaveLength(500);
    expect(result.warning).not.toContain("hidden");
    expect(result.warning).not.toContain("\x1b");
    expect(result.results).toHaveLength(rows.length);
    const text = formatSearch(result);
    expect(text).toContain("Provider warning (untrusted): Some results unavailable.");
    if (!rows.length) {
      expect(text).toContain("does not establish that no matches exist");
      expect(text).not.toContain("No results found");
    }
  }
});

test("missing or malformed warnings do not invent provider diagnostics", async () => {
  for (const warning of [undefined, null, {}, 42, " \n "]) {
    const result = await searchWeb({ query: "q", provider: "firecrawl" }, undefined, { FIRECRAWL_API_KEY: "x" }, async () => Response.json({ success: true, data: { web: [] }, warning }));
    expect(result.warning).toBeUndefined();
    expect(formatSearch(result)).toContain("No results found");
  }
});

test("calendar date windows map to each provider's documented contract", () => {
  const date_range = { start: "2024-02-29", end: "2024-03-01" };
  expect(searchRequest({ query: "q", date_range }, "exa").body).toMatchObject({ startPublishedDate: "2024-02-29T00:00:00.000Z", endPublishedDate: "2024-03-01T23:59:59.999Z" });
  expect(searchRequest({ query: "q", date_range }, "firecrawl").body).toMatchObject({ tbs: "cdr:1,cd_min:2/29/2024,cd_max:3/1/2024" });
  expect(searchRequest({ query: "q", date_range: { start: "2024-02-29", end: "2024-02-29" } }, "exa").body).toHaveProperty("endPublishedDate");
});

test("invalid, impossible or reversed calendar windows fail before any request", async () => {
  let calls = 0;
  for (const date_range of [
    { start: "2023-02-29", end: "2023-03-01" }, { start: "2024-04-31", end: "2024-05-01" },
    { start: "2024-01-02", end: "2024-01-01" }, { start: "2024-1-1", end: "2024-01-02" },
    { start: "2024-01-01T00:00:00Z", end: "2024-01-02" },
  ]) await expect(searchWeb({ query: "q", date_range }, undefined, { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "x" }, (async () => { calls++; return Response.json({ results: [] }); }))).rejects.toThrow("date_range");
  expect(calls).toBe(0);
});

test("date-window provenance is retained even when publication metadata is absent", async () => {
  const date_range = { start: "2024-01-01", end: "2024-01-31" };
  const result = await searchWeb({ query: "q", provider: "firecrawl", date_range }, undefined, { FIRECRAWL_API_KEY: "x" }, async () => Response.json({ data: { web: [{ url: "https://example.com", title: "Undated result" }] } }));
  expect(result.dateRange).toEqual(date_range);
  expect(result.results[0]!.published).toBeUndefined();
  expect(formatSearch(result)).toContain("verify publication dates on sources");
});

test("quality routes deliberately and preserves filters and requested-mode provenance", async () => {
  for (const quality of ["fast", "balanced", "deep"] as const) {
    let calls = 0;
    const result = await searchWeb({ query: "q", quality, domains: ["example.com"], date_range: { start: "2024-01-01", end: "2024-01-31" }, ...(quality === "deep" ? { additional_queries: [" variation "] } : {}) }, undefined,
      { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "x", FIRECRAWL_API_KEY: "y" }, async (url, init) => {
        calls++;
        expect(url).toBe("https://api.exa.ai/search");
        const body = JSON.parse(init!.body as string);
        expect(body.type).toBe(quality === "balanced" ? "auto" : quality);
        expect(body.includeDomains).toEqual(["example.com"]);
        expect(body.startPublishedDate).toBe("2024-01-01T00:00:00.000Z");
        expect(body.additionalQueries).toEqual(quality === "deep" ? ["variation"] : undefined);
        return Response.json({ results: [{ url: "https://example.com", title: "Source" }] });
      });
    expect(calls).toBe(1);
    expect(result.quality).toBe(quality);
    expect(formatSearch(result)).toContain(`Requested search mode: ${quality}`);
    expect(formatSearch(result)).toContain("not a verified quality rating");
  }
});

test("unsupported quality/provider combinations and query variations fail without a request", async () => {
  let calls = 0;
  const request = async () => { calls++; return Response.json({}); };
  await expect(searchWeb({ query: "q", quality: "deep" }, undefined, {}, request)).rejects.toThrow("EXA_API_KEY");
  for (const quality of ["fast", "deep"] as const) {
    await expect(searchWeb({ query: "q", quality, provider: "firecrawl" }, undefined, { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "x", FIRECRAWL_API_KEY: "y" }, request)).rejects.toThrow("requires Exa");
  }
  for (const input of [
    { quality: "unknown" }, { additional_queries: ["q"] },
    { quality: "deep", additional_queries: [] },
    { quality: "deep", additional_queries: [" "] },
    { quality: "deep", additional_queries: ["q".repeat(501)] },
    { quality: "deep", additional_queries: Array(6).fill("q") },
  ]) await expect(searchWeb({ query: "q", ...input } as never, undefined, { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "x" }, request)).rejects.toThrow("No request was sent");
  expect(calls).toBe(0);
});

test("deep failures never retry or fall back to another billable provider", async () => {
  let calls = 0;
  await expect(searchWeb({ query: "q", quality: "deep" }, undefined, { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "x", FIRECRAWL_API_KEY: "y" }, async () => {
    calls++; return new Response("unavailable", { status: 503 });
  })).rejects.toThrow("503");
  expect(calls).toBe(1);
});
