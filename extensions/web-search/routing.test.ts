import { expect, test } from "bun:test";
import { formatSearch, searchWeb, type SearchInput } from "./client.ts";
import { searchPreview } from "./render.ts";

const env = { EXA_API_KEY: "exa-fixture", FIRECRAWL_API_KEY: "firecrawl-fixture", MISTRAL_API_KEY: "mistral-fixture" };
const results = [{ title: "Docs", url: "https://example.com/docs/current", description: "Reference" }];

test("default failures try only configured compatible providers and retain route provenance", async () => {
  const calls: string[] = [];
  const result = await searchWeb({ query: "documentation", domains: ["example.com/docs"], exclude_domains: ["example.com/docs/old"], date_range: { start: "2025-01-01" } }, undefined, env, async (url, init) => {
    calls.push(url);
    if (url.includes("exa.ai")) return new Response(null, { status: 429, headers: { "retry-after": "10" } });
    expect(JSON.parse(String(init?.body))).toMatchObject({ includeDomains: ["example.com"], tbs: "cdr:1,cd_min:1/1/2025,cd_max:" });
    return Response.json({ data: { web: [...results, { url: "https://example.com/docs/old/removed" }, { url: "https://outside.example/" }] } });
  });
  expect(calls).toEqual(["https://api.exa.ai/search", "https://api.firecrawl.dev/v2/search"]);
  expect(result.provider).toBe("firecrawl");
  expect(result.results.map((hit) => hit.url)).toEqual([results[0]!.url]);
  expect(result.attempts).toEqual([{ provider: "exa", outcome: "failed", reason: "HTTP 429" }, { provider: "firecrawl", outcome: "succeeded" }]);
  expect(formatSearch(result)).toContain("exa: failed (HTTP 429) → firecrawl: succeeded");
  expect(searchPreview(result, { fg: (_: string, text: string) => text } as never).render(100).join("\n")).toContain("2 attempts");
});

test("explicit provider pins, unsupported alternate constraints, bad input and empty results never fan out", async () => {
  for (const input of [
    { query: "q", provider: "exa" }, { query: "q", quality: "fast" }, { query: "q", category: "pdf" }, { query: "q", max_age_hours: 0 },
  ] as SearchInput[]) {
    let calls = 0;
    await expect(searchWeb(input, undefined, env, async () => { calls++; return new Response(null, { status: 503 }); })).rejects.toThrow();
    expect(calls).toBe(1);
  }
  let calls = 0;
  await expect(searchWeb({ query: "q", date_range: { start: "bad" } }, undefined, env, async () => { calls++; return Response.json({}); })).rejects.toThrow("No request was sent");
  expect(calls).toBe(0);
  const empty = await searchWeb({ query: "q" }, undefined, env, async () => { calls++; return Response.json({ results: [] }); });
  expect(empty.results).toEqual([]);
  expect(calls).toBe(1);
});

test("route cancellation never triggers another provider, even after an attempt fails", async () => {
  const controller = new AbortController();
  let calls = 0;
  await expect(searchWeb({ query: "q" }, controller.signal, env, async () => {
    calls++; controller.abort(new Error("cancelled")); throw new Error("transport failure");
  })).rejects.toThrow("cancelled");
  expect(calls).toBe(1);
});

test("attempt timeouts reserve fallback time but all attempts share one finite deadline", async () => {
  const requests: string[] = [];
  const began = performance.now();
  await expect(searchWeb({ query: "q" }, undefined, env, async (url, init) => {
    requests.push(url);
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  }, { timeoutMs: 90 })).rejects.toThrow();
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(performance.now() - began).toBeLessThan(1000);
});

test("transport failures remain bounded and do not expose raw errors across fallback routes", async () => {
  await expect(searchWeb({ query: "q" }, undefined, env, async () => { throw new Error("sensitive fixture details"); })).rejects.toThrow("exa (request failed) → firecrawl (request failed) → mistral (request failed)");
  let calls = 0;
  await expect(searchWeb({ query: "q" }, undefined, env, async () => { calls++; return new Response(null, { status: 400 }); })).rejects.toThrow("HTTP 400");
  expect(calls).toBe(1);
});
