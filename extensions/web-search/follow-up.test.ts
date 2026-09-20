import { expect, test } from "bun:test";
import { exaAccess } from "./access.ts";
import { inspectResults, searchRequest } from "./client.ts";
import { publicationInWindow } from "./dates.ts";
import { requestWithRetry } from "./retry.ts";
import { readExaPage } from "./remote-reader.ts";
import { searchPreview } from "./render.ts";
import { formatPage, pagePreview } from "./reader.ts";

test("account access requires deliberate configuration; a key alone is unused", () => {
  expect(exaAccess({ EXA_API_KEY: "unused" })).toBe("keyless");
  expect(exaAccess({ PI_EXA_ACCESS: "api-key", EXA_API_KEY: "configured" })).toBe("api-key");
  expect(() => exaAccess({ PI_EXA_ACCESS: "api-key" })).toThrow("EXA_API_KEY");
  expect(() => exaAccess({ PI_EXA_ACCESS: "auto" })).toThrow("No request");
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
test("retries honor short cooldowns, never replay transport ambiguity or long cooldowns, and abort the wait", async () => {
  let calls = 0;
  const request = async () => ++calls === 1 ? new Response(null, { status: 429, headers: { "retry-after": "0" } }) : Response.json({});
  expect((await requestWithRetry(request, "https://example.com", {}, false)).ok).toBe(true);
  expect(calls).toBe(2);
  for (const status of [401, 402, 503]) {
    calls = 0;
    await requestWithRetry(async () => { calls++; return new Response(null, { status }); }, "https://example.com", {}, false);
    expect(calls).toBe(1);
  }
  calls = 0;
  await expect(requestWithRetry(async () => { calls++; throw new Error("network"); }, "https://example.com", {}, true)).rejects.toThrow("network");
  expect(calls).toBe(1);
  calls = 0;
  await requestWithRetry(async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": "30" } }); }, "https://example.com", {}, true);
  expect(calls).toBe(1);
  const controller = new AbortController();
  const pending = requestWithRetry(async () => new Response(null, { status: 503 }), "https://example.com", { signal: controller.signal }, true);
  setTimeout(() => controller.abort(), 10);
  await expect(pending).rejects.toThrow();
});
test("remote PDF extraction preserves access and reported source without inventing completeness", async () => {
  const page = await readExaPage({ url: "https://example.com/paper.pdf", reader: "exa" }, undefined, { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "key" }, async (url, init) => {
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
