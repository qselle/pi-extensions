import { expect, test } from "bun:test";
import { formatSearch, inspectResults, searchRequest, searchWeb, type SearchInput } from "./client.ts";
import { normalizeDomains } from "./filters.ts";
import { searchPreview } from "./render.ts";

test("source scopes preserve path case and enforce host and segment boundaries across providers", () => {
  expect(normalizeDomains([" DOCS.EXAMPLE.COM/API/ ", "docs.example.com/API"])).toEqual(["docs.example.com/API"]);
  const urls = [
    "https://docs.example.com/API", "https://sub.docs.example.com/API/guide",
    "https://docs.example.com/API/old/page", "https://docs.example.com/API/older",
    "https://docs.example.com/APIs/guide", "https://docs.example.com/api/guide",
    "https://docs.example.com.evil.test/API", "https://example.net/?next=docs.example.com/API",
    "https://docs.example.com/API/%6Fld/page", "https://docs.example.com/API/../elsewhere",
  ];
  const rows = urls.map((url) => ({ url, title: "Documentation" }));
  for (const provider of ["exa", "firecrawl", "mistral"] as const) {
    const raw = provider === "exa" ? { results: rows } : provider === "firecrawl" ? { data: { web: rows } }
      : { outputs: [{ type: "message.output", role: "assistant", content: rows.map((row) => ({ ...row, type: "tool_reference", tool: "web_search" })) }] };
    const result = inspectResults(raw, provider, 10, ["DOCS.EXAMPLE.COM/API"], undefined, ["docs.example.com/API/old"]);
    expect(result.results.map((row) => row.url)).toEqual([urls[0]!, urls[1]!, urls[3]!]);
    expect(result.diagnostics).toMatchObject({ received: 10, outsideDomains: 5, excludedDomains: 2 });
  }
  expect(searchRequest({ query: "q", domains: ["DOCS.EXAMPLE.COM/API"] }, "exa").body).toMatchObject({ includeDomains: ["docs.example.com/API"] });
  expect(searchRequest({ query: "q", domains: ["docs.example.com/API"] }, "firecrawl").body).toMatchObject({ includeDomains: ["docs.example.com"] });
});

test("malformed scopes and incompatible category/freshness constraints fail before any request", async () => {
  const invalid: SearchInput[] = [
    ...["https://example.com", "example.com:8080", "user@example.com", "example.com/a?q=x", "example.com/#x", "example.com/a\\b", "example.com/%zz", "example.com/a%2fb"].map((domain) => ({ query: "q", domains: [domain] })),
    ...[-2, 721, 1.5, NaN, Infinity].map((max_age_hours) => ({ query: "q", max_age_hours })),
    { query: "q", provider: "firecrawl", max_age_hours: 0 },
    { query: "q", provider: "mistral", max_age_hours: 0 },
    { query: "q", category: "publication", domains: ["arxiv.org"] },
    { query: "q", category: "people", date_range: { start: "2026-01-01" } },
    { query: "q", category: "company", exclude_domains: ["example.com"] },
    { query: "q", provider: "unknown" as never },
  ];
  let calls = 0;
  for (const input of invalid) await expect(searchWeb(input, undefined, { FIRECRAWL_API_KEY: "key", MISTRAL_API_KEY: "key" }, async () => { calls++; return Response.json({}); })).rejects.toThrow();
  expect(calls).toBe(0);
});

test("tracking variants collapse without merging distinct queries or rewriting citation URLs", () => {
  const first = "https://example.com/page?version=2&utm_source=search#section";
  const result = inspectResults({ results: [first, "https://example.com/page?version=2&fbclid=click", "https://example.com/page?version=3", "https://example.com/page?ref=reference"].map((url) => ({ url })) }, "exa", 10);
  expect(result.results.map((row) => row.url)).toEqual([first, "https://example.com/page?version=3", "https://example.com/page?ref=reference"]);
  expect(result.diagnostics.duplicate).toBe(1);
});

test("malformed path escapes cannot bypass host or path exclusions", () => {
  for (const excluded of ["example.com", "example.com/private"]) {
    const result = inspectResults({ results: [{ url: "https://example.com/private/%zz" }] }, "exa", 5, [], undefined, [excluded]);
    expect(result.results).toEqual([]);
    expect(result.diagnostics.excludedDomains).toBe(1);
  }
});

test("freshness is explicit and distinct from publication dates in requests, results and display", async () => {
  for (const max_age_hours of [-1, 0, 24, 720]) {
    const result = await searchWeb({ query: "current API", domains: ["docs.example.com/API"], max_age_hours, date_range: { start: "2026-01-01" } }, undefined, { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "key" }, async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ contents: { highlights: true, maxAgeHours: max_age_hours }, startPublishedDate: "2026-01-01T00:00:00.000Z", includeDomains: ["docs.example.com/API"] });
      return Response.json({ results: [{ url: "https://docs.example.com/API/v2" }, { url: "https://docs.example.com/api/v1" }] });
    });
    expect(result.results).toHaveLength(1);
    expect(result.maxAgeHours).toBe(max_age_hours);
    expect(formatSearch(result)).toContain("Content freshness:");
    expect(formatSearch(result)).toContain("not independently verified");
    const preview = searchPreview(result, { fg: (_color: string, text: string) => text } as never).render(120).join("\n");
    expect(preview).toContain("docs.example.com/API");
    expect(preview).toContain("Content freshness:");
  }
});
