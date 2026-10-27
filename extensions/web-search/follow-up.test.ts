import { expect, test } from "bun:test";
import { exaAccess, exaAccessPlan } from "./access.ts";
import { inspectResults, searchRequest } from "./client.ts";
import { publicationInWindow } from "./dates.ts";
import { RATE_LIMIT_DELAYS_MS, requestWithRetry } from "./retry.ts";
import { readExaPage } from "./remote-reader.ts";
import { searchPreview } from "./render.ts";
import { formatPage, pagePreview } from "./reader.ts";

test("access is keyless first; a key is a paid fallback unless a mode is forced or required", () => {
  expect(exaAccessPlan({})).toEqual({ first: "keyless", paidFallback: false });
  expect(exaAccessPlan({ EXA_API_KEY: " \n " })).toEqual({ first: "keyless", paidFallback: false });
  expect(exaAccessPlan({ EXA_API_KEY: "configured" })).toEqual({ first: "keyless", paidFallback: true });
  expect(exaAccessPlan({ EXA_API_KEY: "configured" }, true)).toEqual({ first: "api-key", paidFallback: false });
  expect(exaAccessPlan({ EXA_API_KEY: "configured", PI_EXA_ACCESS: "API-KEY" })).toEqual({ first: "api-key", paidFallback: false });
  expect(exaAccessPlan({ EXA_API_KEY: "configured", PI_EXA_ACCESS: "keyless" }, true)).toEqual({ first: "keyless", paidFallback: false });
  expect(exaAccessPlan({ PI_EXA_ACCESS: "api-key" })).toEqual({ first: "keyless", paidFallback: false });
  expect(exaAccess({ EXA_API_KEY: "configured", PI_EXA_ACCESS: "unknown" })).toBe("keyless");
});
test("one-sided dates, exclusions and source category retain precise semantics", () => {
  expect(searchRequest({ query: "q", date_range: { start: "2025-01-01" }, exclude_domains: [" EXAMPLE.COM "], category: "pdf" }, "exa").body).toMatchObject({ startPublishedDate: "2025-01-01T00:00:00.000Z", excludeDomains: ["example.com"], category: "pdf" });
  expect(searchRequest({ query: "q", date_range: { end: "2025-01-01" } }, "exa").body).not.toHaveProperty("startPublishedDate");
  expect(() => searchRequest({ query: "q", date_range: {} }, "exa")).toThrow();
  expect(publicationInWindow("2024", { start: "2025-01-01" })).toBe("outside");
  expect(publicationInWindow("2024", { end: "2025-01-01" })).toBe("inside");
  const result = inspectResults({ results: ["example.com", "sub.example.com", "notexample.com"].map((host) => ({ url: `https://${host}` })) }, "exa", 5, [], undefined, ["example.com"]);
  expect(result.results.map((hit) => hit.url)).toEqual(["https://notexample.com/"]);
  expect(result.diagnostics.excludedDomains).toBe(2);
});
test("rate-limit retries follow Retry-After within the deadline and never replay transport failures", async () => {
  const deadline = () => performance.now() + 5_000;
  let calls = 0;
  const limited = async () => ++calls <= 3 ? new Response(null, { status: 429, headers: { "retry-after": "0" } }) : Response.json({});
  expect((await requestWithRetry(limited, "https://example.com", {}, { deadline: deadline(), rateLimit: true })).ok).toBe(true);
  expect(calls).toBe(4);
  calls = 0;
  const always = async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": "0" } }); };
  expect((await requestWithRetry(always, "https://example.com", {}, { deadline: deadline(), rateLimit: true })).status).toBe(429);
  expect(calls).toBe(RATE_LIMIT_DELAYS_MS.length + 1);
  // Account errors, account 5xx, and 429 with a paid fallback waiting are returned at once.
  for (const [status, rateLimit] of [[401, true], [402, true], [503, true], [429, false]] as const) {
    calls = 0;
    await requestWithRetry(async () => { calls++; return new Response(null, { status }); }, "https://example.com", {}, { deadline: deadline(), rateLimit });
    expect(calls).toBe(1);
  }
  calls = 0;
  await expect(requestWithRetry(async () => { calls++; throw new Error("network"); }, "https://example.com", {}, { deadline: deadline(), rateLimit: true, serverErrors: true })).rejects.toThrow("network");
  expect(calls).toBe(1);
  // Neither a long Retry-After nor the first backoff step may outlast the deadline.
  for (const headers of [{ "retry-after": "30" }, undefined]) {
    calls = 0;
    const started = performance.now();
    await requestWithRetry(async () => { calls++; return new Response(null, { status: 429, headers }); }, "https://example.com", {}, { deadline: performance.now() + 900, rateLimit: true });
    expect(calls).toBe(1);
    expect(performance.now() - started).toBeLessThan(500);
  }
  const controller = new AbortController();
  const pending = requestWithRetry(async () => new Response(null, { status: 503 }), "https://example.com", { signal: controller.signal }, { deadline: deadline(), rateLimit: true, serverErrors: true });
  setTimeout(() => controller.abort(), 10);
  await expect(pending).rejects.toThrow();
});
test("remote PDF extraction preserves access and reported source without inventing completeness", async () => {
  const page = await readExaPage({ url: "https://example.com/paper.pdf", reader: "exa" }, undefined, { EXA_API_KEY: "key", PI_EXA_ACCESS: "api-key" }, async (url, init) => {
    expect(url).toBe("https://api.exa.ai/contents");
    expect(JSON.parse(String(init?.body))).toEqual({ urls: ["https://example.com/paper.pdf"], text: { maxCharacters: 8000 } });
    return Response.json({ results: [{ url: "https://example.com/final.pdf", text: "Text\n\x1b[31mred\x1b[0m" }] });
  });
  expect(page.text).toBe("Text\nred");
  expect(formatPage(page)).toContain("Provider-reported source URL: https://example.com/final.pdf");
  expect(formatPage(page)).toContain("no continuation");
  expect(pagePreview(page)).toContain("api-key");
  let calls = 0;
  await expect(readExaPage({ url: "https://example.com", mode: "extract", selector: "p" }, undefined, {}, async () => { calls++; return Response.json({}); })).rejects.toThrow("No request");
  expect(calls).toBe(0);
});


test("one-sided date previews and remote truncation give usable next steps", () => {
  const preview = searchPreview({ provider: "exa", query: "q", results: [], dateRange: { start: "2025-01-01" } }, { fg: (_color: string, text: string) => text } as never).render(80).join("\n");
  expect(preview).toContain("any end"); expect(preview).not.toContain("undefined");
  const page = formatPage({ url: "https://example.com/p.pdf", reader: "exa", text: "excerpt", notes: "", truncated: true });
  expect(page).toContain("Increase budget"); expect(page).not.toContain("CSS selector");
});
