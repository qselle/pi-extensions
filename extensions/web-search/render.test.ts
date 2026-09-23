import { expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getHyperlinkMode, hasDanglingLink, setHyperlinkMode } from "../../lib/links.ts";
import { searchPreview } from "./render.ts";
import type { SearchResult } from "./client.ts";

const theme = { fg: (_name: string, text: string) => text } as never;
const details: SearchResult = {
  provider: "exa", access: "api-key", query: "specific query", quality: "balanced", elapsedMs: 1234,
  results: Array.from({ length: 8 }, (_, i) => ({ title: `Source ${i + 1} 界`, url: `https://docs.example.com/guide/${i + 1}`, snippet: `Evidence ${i + 1} explains the relevant behavior.`, published: "2026-09-21" })),
};

test("collapsed search is one summary and three sources; expansion reveals all evidence", () => {
  const preview = searchPreview(details, theme).render(100);
  expect(preview[0]).toContain("8 sources · Exa · API · 1.2s");
  expect(preview).toHaveLength(5);
  expect(stripTerminalSequences(preview[1]!)).toBe("    1. Source 1 界 · docs.example.com");
  expect(preview.join("\n")).toContain("+5 more");
  expect(preview.join("\n")).not.toContain("Evidence");
  const expanded = searchPreview(details, theme, true).render(100).join("\n");
  for (let i = 1; i <= 8; i++) expect(expanded).toContain(`Evidence ${i}`);
  expect(expanded).toContain("Published 2026-09-21");
  expect(expanded).not.toContain("+5 more");
});

test("URL-only titles render once, and expansion preserves long URL text", () => {
  const url = "https://example.com/" + "long-path/".repeat(20);
  const result = { ...details, results: [{ title: url, url, snippet: "" }] };
  // A normal URL-only title never repeats the source row.
  const short = { ...details, results: [{ title: "https://example.com/", url: "https://example.com/", snippet: "" }] };
  expect(searchPreview(short, theme).render(100).map(stripTerminalSequences).filter((line) => line.includes("example.com"))).toHaveLength(1);
  const expanded = searchPreview(result, theme, true).render(40);
  expect(expanded.map(stripTerminalSequences).map((line) => line.trim()).join("")).toContain(url);
});

test("long titles reserve the visible origin and remain linked", () => {
  const before = getHyperlinkMode();
  try {
    setHyperlinkMode("always");
    const url = "https://docs.example.org/guide";
    const result = { ...details, results: [{ title: "A long title with Unicode 界 ".repeat(20), url, snippet: "" }] };
    const row = searchPreview(result, theme).render(60)[1]!;
    expect(stripTerminalSequences(row)).toEndWith(" · docs.example.org");
    expect(row).toContain(`\x1b]8;;${url}`);
    expect(stripTerminalSequences(row)).toContain("A long title");
    expect(searchPreview(result, theme).render(26).map(stripTerminalSequences).some((line) => line.includes("docs.example.org"))).toBe(true);
  } finally { setHyperlinkMode(before); }
});

test("both display modes fit every width and close all terminal hyperlinks", () => {
  const before = getHyperlinkMode();
  try {
    for (const mode of ["always", "never"] as const) {
      setHyperlinkMode(mode);
      for (const expanded of [false, true]) {
        const component = searchPreview(details, theme, expanded);
        for (let width = 0; width <= 100; width++) {
          const lines = component.render(width);
          expect(lines.every((line) => visibleWidth(line) <= width && !hasDanglingLink(line))).toBe(true);
        }
      }
    }
  } finally { setHyperlinkMode(before); }
});
