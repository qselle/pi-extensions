import { expect, test } from "bun:test";
import { readExaPage } from "./remote-reader.ts";
import { formatPage } from "./reader.ts";
import { pageContentFailure } from "./page-content.ts";
import type { Fetch } from "./client.ts";

const keyed = { PI_EXA_ACCESS: "api-key", EXA_API_KEY: "key" };
function keylessPage(text: string): Fetch {
  return async (_url, init) => {
    const message = JSON.parse(String(init?.body));
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } } : { content: [{ type: "text", text }] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  };
}

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
