import { expect, test } from "bun:test";
import { readExaPage, remoteOrder } from "./remote-reader.ts";
import { formatPage, pagePreview, readPage } from "./reader.ts";
import { pageContentFailure } from "./page-content.ts";
import type { Fetch } from "./client.ts";

const keyed = { EXA_API_KEY: "key", PI_EXA_ACCESS: "api-key" };
function keylessPage(text: string): Fetch {
  return async (_url, init) => {
    const message = JSON.parse(String(init?.body));
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } } : { content: [{ type: "text", text }] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  };
}

test("remote page reading shares the search access policy", async () => {
  const page = await readExaPage({ url: "https://example.com" }, undefined, { EXA_API_KEY: " key ", PI_EXA_ACCESS: "api-key" }, async (url, init) => {
    expect(url).toBe("https://api.exa.ai/contents");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("key");
    return Response.json({ results: [{ text: "Direct page content." }] });
  });
  expect(page.access).toBe("api-key");
  const publicRequest = keylessPage("Public page content.");
  const publicPage = await readExaPage({ url: "https://example.com" }, undefined, { EXA_API_KEY: "key" }, async (url, init) => {
    expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
    return publicRequest(url, init);
  });
  expect(publicPage.access).toBe("keyless");
  const fallback = await readExaPage({ url: "https://example.com" }, undefined, { EXA_API_KEY: "key" }, async (url) =>
    url.startsWith("https://mcp.exa.ai") ? new Response(null, { status: 429 }) : Response.json({ results: [{ text: "Paid page content." }] }));
  expect(fallback).toMatchObject({ access: "api-key", accessFallback: "HTTP 429", text: "Paid page content." });
  expect(formatPage(fallback)).toContain("after keyless access failed with HTTP 429");
});

test("both remote access modes reject empty and challenge-only success payloads", async () => {
  for (const text of ["   ", "\x1b[31m\x1b[0m", "# Just a moment...", "403 Forbidden", "Verify you are human"]) {
    await expect(readExaPage({ url: "https://example.com" }, undefined, {}, keylessPage(text))).rejects.toThrow(/no readable content|access challenge/);
    await expect(readExaPage({ url: "https://example.com" }, undefined, keyed, async () => Response.json({ results: [{ text }] }))).rejects.toThrow(/no readable content|access challenge/);
  }
  for (const text of ["Access Denied: understanding HTTP status codes", "This article explains checking your browser...", "Tiny page."]) expect(pageContentFailure(text)).toBeUndefined();
});

test("freshness maps to the account contents API and unsupported reader constraints never send", async () => {
  const page = await readExaPage({ url: "https://example.com", reader: "exa", max_age_hours: 0 }, undefined, keyed, async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({ urls: ["https://example.com/"], text: { maxCharacters: 8000 }, maxAgeHours: 0 });
    return Response.json({ results: [{ text: "Current content." }] });
  });
  expect(page.maxAgeHours).toBe(0);
  expect(formatPage(page)).toContain("fresh fetch · requested, not independently verified");
  let calls = 0;
  for (const extra of [{ max_age_hours: 0 }, { max_age_hours: -2 }, { selector: "" }, { offset: NaN }]) {
    await expect(readExaPage({ url: "https://example.com", ...extra }, undefined, {}, async () => { calls++; return Response.json({}); })).rejects.toThrow("No request was sent");
  }
  expect(calls).toBe(0);
});

test("remote text reaching the excerpt cap is marked and controls do not consume its budget", async () => {
  for (const env of [{}, keyed]) {
    const text = "\x1b[31m" + "x".repeat(400) + "\x1b[0m";
    const page = await readExaPage({ url: "https://example.com", budget: 100 }, undefined, env, env === keyed ? async () => Response.json({ results: [{ text }] }) : keylessPage(text));
    expect(page.text).toBe("x".repeat(400));
    expect(page.truncated).toBe(true);
    expect(formatPage(page)).toContain("Increase budget");
  }
});

test("challenge and JavaScript walls near the top of short pages are failures; articles are not", () => {
  for (const text of [
    "example.com\n\n## Performing security verification\nThis website uses a security service.",
    "# Verify you are human by completing the action below.",
    "Please enable JavaScript to view this page.",
    "- Complete the CAPTCHA to continue",
  ]) expect(pageContentFailure(text)).toContain("access challenge");
  for (const text of [
    "How CAPTCHA works\n\nArticles explain that sites ask you to verify you are human.",
    `Guide\n\n${"Long article text. ".repeat(600)}\nVerify you are human`,
  ]) expect(pageContentFailure(text)).toBeUndefined();
});

const mcpPage = (text: string) => async (url: string, init?: RequestInit) => {
  const message = JSON.parse(String(init?.body));
  return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }], ...(url.includes("mistral") ? { structuredContent: { url: message.params.arguments.url, content: text } } : {}) } });
};

test("remote reading falls back from Exa to Firecrawl to Mistral and records the route", async () => {
  const calls: string[] = [];
  const env = { FIRECRAWL_API_KEY: "fc", MISTRAL_API_KEY: "mi" };
  const page = await readPage({ url: "https://example.com/js", reader: "remote" }, undefined, { env, request: async (url, init) => {
    calls.push(new URL(url).host);
    if (url.includes("exa.ai")) return mcpPage("Checking your browser before accessing example.com.")(url, init);
    if (url.includes("firecrawl")) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ url: "https://example.com/js", formats: ["markdown"], onlyMainContent: true });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fc");
      return new Response(null, { status: 402 });
    }
    return mcpPage("Rendered article body.")(url, init);
  } });
  expect(calls).toEqual(["mcp.exa.ai", "api.firecrawl.dev", "api.mistral.ai"]);
  expect(page).toMatchObject({ reader: "mistral", text: "Rendered article body." });
  expect(page.route).toEqual([{ reader: "exa", outcome: "failed", reason: "access challenge" }, { reader: "firecrawl", outcome: "failed", reason: "HTTP 402" }, { reader: "mistral", outcome: "succeeded" }]);
  expect(formatPage(page)).toContain("Read route: exa: failed (access challenge) → firecrawl: failed (HTTP 402) → mistral: succeeded.");
  expect(pagePreview(page)).toBe("Mistral · via Exa → Firecrawl → Mistral · excerpt received · completeness unverified");
});

test("PI_WEB_OPEN_PROVIDER goes first, unconfigured readers are skipped, and pinned readers never fall back", async () => {
  expect(remoteOrder({})).toEqual(["exa"]);
  expect(remoteOrder({ FIRECRAWL_API_KEY: "fc", PI_WEB_OPEN_PROVIDER: "Firecrawl" })).toEqual(["firecrawl", "exa"]);
  expect(remoteOrder({ PI_WEB_OPEN_PROVIDER: "mistral" })).toEqual(["exa"]);
  const calls: string[] = [];
  const failing = async (url: string) => { calls.push(new URL(url).host); return new Response(null, { status: 503 }); };
  await expect(readPage({ url: "https://example.com", reader: "firecrawl" }, undefined, { env: { FIRECRAWL_API_KEY: "fc", MISTRAL_API_KEY: "mi" }, request: failing })).rejects.toThrow("Firecrawl page reading failed (HTTP 503)");
  expect(calls).toEqual(["api.firecrawl.dev"]);
  await expect(readPage({ url: "https://example.com", reader: "firecrawl" }, undefined, { env: {}, request: failing })).rejects.toThrow("No request was sent");
  await expect(readPage({ url: "https://example.com", reader: "remote", selector: "main", mode: "extract" }, undefined, { env: {}, request: failing })).rejects.toThrow("No request was sent");
  expect(calls).toHaveLength(1);
});

test("Mistral article IDs open through the connector; other readers reject them before any request", async () => {
  let opened: unknown;
  const page = await readPage({ url: "AFP-2026-0001" }, undefined, { env: { MISTRAL_API_KEY: "mi" }, mistralBaseUrl: "https://api.mistral.ai/v1", request: async (url, init) => {
    expect(url).toBe("https://api.mistral.ai/v1/connectors-gateway/web_search/mcp");
    opened = JSON.parse(String(init?.body)).params;
    return mcpPage("Wire story text.")(url, init);
  } });
  expect(opened).toEqual({ name: "open_url", arguments: { url: "AFP-2026-0001" } });
  expect(page).toMatchObject({ url: "AFP-2026-0001", reader: "mistral", text: "Wire story text." });
  await expect(readPage({ url: "AFP-2026-0001", reader: "ax" })).rejects.toThrow("reader=mistral");
  await expect(readPage({ url: "AFP-2026-0001", reader: "mistral" }, undefined, { env: { MISTRAL_API_KEY: "mi" }, request: mcpPage("Open blocked: robots.txt") })).rejects.toThrow("Mistral reported that the page is blocked");
});
