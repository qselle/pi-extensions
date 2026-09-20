import { expect, test } from "bun:test";
import { axArgs, formatPage, readPage, parseExtraction, pagePreview } from "./reader.ts";

test("reader builds bounded argument vectors, preserving selectors as literal arguments", () => {
  const args = axArgs({ url: "https://example.com/", mode: "extract", selector: "a[href='$(touch /tmp/no)']", offset: 10 });
  expect(args.slice(0, 5)).toEqual(["https://example.com/", "a[href='$(touch /tmp/no)']", "--row", "text=", "--json-envelope"]);
  expect(args).toContain("--no-cache");
  expect(args).toContain("--max-bytes");
  expect(args.slice(args.indexOf("--offset"), args.indexOf("--offset") + 2)).toEqual(["--offset", "10"]);
  expect(axArgs({ url: "https://example.com" })).toContain("--md");
  expect(axArgs({ url: "https://example.com", mode: "outline" })).toContain("--outline");
});

test("reader rejects local paths, credentials, invalid bounds and option-shaped selectors", () => {
  for (const input of [
    { url: "/etc/passwd" }, { url: "file:///tmp/page" }, { url: "https://u:p@example.com" },
    { url: "https://example.com", budget: 0 }, { url: "https://example.com", offset: -1 },
    { url: "https://example.com", mode: "markdown" as const, offset: 1 },
    { url: "https://example.com", mode: "extract" as const, selector: "--help" },
  ]) expect(() => axArgs(input)).toThrow();
});

test("reader preserves truncation and completeness notes", () => {
  const text = formatPage({ url: "https://example.com/", text: "page", notes: "continue with --offset 50", truncated: true });
  expect(text).toContain("--offset 50");
  expect(text).toContain("not the complete page");
  expect(text).toContain("Untrusted page content");
});

test("already cancelled reads never spawn ax", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(readPage({ url: "https://example.com" }, controller.signal)).rejects.toThrow();
});

test("structured extraction exposes continuation and rejects incomplete metadata", () => {
  const result = parseExtraction(JSON.stringify({ data: [{ text: "one" }, { text: "two" }], meta: { state: "more", next_offset: 2 } }));
  expect(result).toEqual({ text: "one\ntwo", pagination: { state: "more", nextOffset: 2 } });
  expect(formatPage({ url: "https://example.com", text: result.text, notes: "", truncated: false, pagination: result.pagination })).toContain("Continue with offset 2");
  expect(() => parseExtraction(JSON.stringify({ data: [], meta: { state: "more", next_offset: null } }))).toThrow();
  expect(parseExtraction(JSON.stringify({ data: [], meta: { state: "past_end", next_offset: null } })).pagination.state).toBe("past_end");
});


test("continuation must advance and offsets must be safely representable", () => {
  const envelope = JSON.stringify({ data: [{ text: "page" }], meta: { state: "more", next_offset: 10 } });
  expect(parseExtraction(envelope, 9).pagination.nextOffset).toBe(10);
  for (const offset of [10, 11]) expect(() => parseExtraction(envelope, offset)).toThrow("does not advance");
  expect(() => axArgs({ url: "https://example.com", mode: "extract", selector: "p", offset: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
});

test("page previews distinguish selection progress, unknown completeness and hard truncation", () => {
  expect(pagePreview({ truncated: false })).toContain("completeness unverified");
  expect(pagePreview({ truncated: false, pagination: { state: "more", nextOffset: 42 } })).toContain("next offset 42");
  expect(pagePreview({ truncated: false, pagination: { state: "complete", nextOffset: null } })).toContain("selection complete");
  expect(pagePreview({ truncated: false, pagination: { state: "past_end", nextOffset: null } })).toContain("past end");
  for (const state of ["more", "complete", "past_end"] as const) {
    expect(pagePreview({ truncated: true, pagination: { state, nextOffset: state === "more" ? 42 : null } })).toContain("output capped");
  }
});
