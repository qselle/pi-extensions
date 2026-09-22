import { expect, test } from "bun:test";
import { publicationBounds, publicationInWindow } from "./dates.ts";
import { formatSearch, searchWeb } from "./client.ts";
const window = { start: "2024-02-29", end: "2024-02-29" };
test("publication filtering respects UTC day boundaries and explicit precision", () => {
  for (const value of ["2024-02-29", "2024-03-01T00:30:00+01:00", "2024-02-28T23:30:00-01:00"]) expect(publicationInWindow(value, window)).toBe("inside");
  for (const value of ["2020", "2024-01", "2024-03-01T00:00:00Z", "2024-02-29T00:00:00+01:00"]) expect(publicationInWindow(value, window)).toBe("outside");
  for (const value of ["2024", "2024-02", undefined, "unknown", "02/29/2024", "2024-02-30"]) expect(publicationInWindow(value, window)).toBe("uncertain");
  expect(publicationBounds("2024-02")?.end).toBe(Date.parse("2024-02-29T23:59:59.999Z"));
});
test("registered request path rejects known old sources and labels uncertain dates", async () => {
  for (const provider of ["exa", "firecrawl"] as const) {
    const rows = ["2020-01-01", "2024-02-29", "2024", undefined].map((publishedDate, index) => ({ url: `https://example.com/${index}`, publishedDate }));
    const result = await searchWeb({ query: "q", provider, date_range: window }, undefined, { EXA_API_KEY: "fixture", FIRECRAWL_API_KEY: "fixture" }, async () => Response.json(provider === "exa" ? { results: rows } : { data: { web: rows } }));
    expect(result.results).toHaveLength(3);
    expect(result.diagnostics?.outsideDates).toBe(1);
    expect(result.diagnostics?.uncertainDates).toBe(2);
    expect(formatSearch(result)).toContain("1 outside requested dates");
    expect(formatSearch(result)).toContain("Published: unknown (range match unverified)");
  }
});
