import { expect, test } from "bun:test";
import { formatSearch, inspectResults, searchWeb, selectProvider } from "./client.ts";

const reference = (url: unknown, title = "Source") => ({ type: "tool_reference", tool: "web_search", url, title, description: "Citation metadata" });
const response = (content: unknown[]) => ({ outputs: [{ type: "message.output", role: "assistant", content }] });

test("Mistral uses a single non-stored conversation with only the explicit search query", async () => {
  let calls = 0;
  const result = await searchWeb({ query: "current query", provider: "mistral", domains: ["example.com"] }, undefined,
    { MISTRAL_API_KEY: "secret", EXA_API_KEY: "other" }, async (url, init) => {
      calls++;
      expect(url).toBe("https://api.mistral.ai/v1/conversations");
      expect(init!.headers).toEqual({ "content-type": "application/json", Authorization: "Bearer secret" });
      expect(init!.redirect).toBe("error");
      expect(init!.signal).toBeDefined();
      const body = JSON.parse(init!.body as string);
      expect(body).toMatchObject({ store: false, stream: false, model: "mistral-medium-latest", inputs: "current query", tools: [{ type: "web_search" }], completion_args: { max_tokens: 2000, temperature: 0 } });
      expect(body.instructions).toContain("example.com");
      expect(body.agent_id).toBeUndefined();
      return Response.json(response([{ type: "text", text: "Invented answer https://unverified.test" }, reference("https://example.com/source")]));
    });
  expect(calls).toBe(1);
  expect(result.results).toEqual([{ title: "Source", url: "https://example.com/source", snippet: "Citation metadata" }]);
  expect(formatSearch(result)).toContain("model-selected");
  expect(formatSearch(result)).not.toContain("Invented answer");
  expect(result.searchType).toBe("web_search citations");
});

test("citation normalization filters domains, duplicates, missing URLs and non-web references", () => {
  const raw = response([
    reference("https://example.com/#one"), reference("https://example.com/#two"),
    reference("https://docs.example.com/"), reference("https://example.com.evil.test/"),
    reference("javascript:alert(1)"), reference(null),
    { ...reference("https://example.com/library"), tool: "document_library" },
    { type: "text", text: "https://example.com/generated-link" },
  ]);
  const result = inspectResults(raw, "mistral", 5, ["example.com"]);
  expect(result.results).toHaveLength(2);
  expect(result.diagnostics).toEqual({ received: 6, invalid: 2, duplicate: 1, outsideDomains: 1, omitted: 0 });
  expect(() => inspectResults({}, "mistral", 5)).toThrow("unexpected response");
  expect(inspectResults(response([{ type: "text", text: "No search performed" }]), "mistral", 5).results).toEqual([]);
});

test("Mistral is opt-in and unsupported filters fail before any request", async () => {
  expect(selectProvider(undefined, { MISTRAL_API_KEY: "secret" })).toBe("exa");
  expect(selectProvider("mistral", { MISTRAL_API_KEY: "secret" })).toBe("mistral");
  let calls = 0;
  for (const extra of [
    { quality: "fast" }, { quality: "deep" },
    { date_range: { start: "2024-01-01", end: "2024-01-02" } },
  ]) await expect(searchWeb({ query: "q", provider: "mistral", ...extra } as never, undefined, { MISTRAL_API_KEY: "secret" }, async () => { calls++; return Response.json({}); })).rejects.toThrow("No request was sent");
  expect(calls).toBe(0);
});

test("Mistral failures do not retry or switch providers", async () => {
  let calls = 0;
  await expect(searchWeb({ query: "q", provider: "mistral" }, undefined, { MISTRAL_API_KEY: "secret", EXA_API_KEY: "other" }, async () => {
    calls++; return new Response("failure", { status: 429 });
  })).rejects.toThrow("Rate limited");
  expect(calls).toBe(1);
});
