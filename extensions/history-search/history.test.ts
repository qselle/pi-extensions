import { expect, test } from "bun:test";
import {
  displayHistoryText,
  extractHistory,
  fuzzyMatch,
  initialHistoryQuery,
  rankHistory,
  type HistoryItem,
} from "./history.ts";

function user(content: unknown) {
  return { type: "message", message: { role: "user", content } };
}

test("extracts newest-first public session history and current-process inputs", () => {
  const entries = [
    user("older prompt"),
    { type: "custom_message", content: "hidden steering" },
    user([{ type: "text", text: "multiline\nprompt" }, { type: "image", data: "..." }]),
    { type: "message", message: { role: "bashExecution", command: "git status", excludeFromContext: false } },
    { type: "message", message: { role: "bashExecution", command: "secret", excludeFromContext: true } },
    user("duplicate"),
  ];
  const history = extractHistory(entries, ["duplicate", "retry before persistence", "newest prompt"]);

  expect(history.map((item) => item.text)).toEqual([
    "newest prompt",
    "retry before persistence",
    "duplicate",
    "!!secret",
    "!git status",
    "multiline\nprompt",
    "older prompt",
  ]);
  expect(history.map((item) => item.recency)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(history.find((item) => item.text === "duplicate")?.source).toBe("input");
});

test("keeps the complete branch and every ranked match searchable", () => {
  const entries = Array.from({ length: 650 }, (_, index) => user(`shared needle prompt ${index}`));
  entries[0] = user(`${"long ".repeat(900)}tail needle`);
  const history = extractHistory(entries);
  expect(history).toHaveLength(650);

  const ranked = rankHistory(history, "needle");
  expect(ranked).toHaveLength(650);
  expect(ranked.some((item) => item.text.endsWith("prompt 649"))).toBe(true);
  expect(ranked.some((item) => item.text.endsWith("tail needle"))).toBe(true);
});

test("ignores empty, image-only, assistant, and malformed entries", () => {
  const history = extractHistory([
    user("  "),
    user([{ type: "image", data: "..." }]),
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "not input" }] } },
    null,
    {},
  ]);
  expect(history).toEqual([]);
});

test("ranks exact, prefix, substring, boundary, and subsequence matches", () => {
  const items: HistoryItem[] = [
    { text: "deploy production", source: "message", recency: 0 },
    { text: "production deploy notes", source: "message", recency: 1 },
    { text: "dp", source: "message", recency: 2 },
    { text: "debug parser", source: "message", recency: 3 },
    { text: "unrelated", source: "message", recency: 4 },
  ];

  const exact = rankHistory(items, "dp");
  expect(exact[0]?.text).toBe("dp");
  expect(exact.map((item) => item.text)).not.toContain("unrelated");
  expect(exact.find((item) => item.text === "deploy production")?.positions).toEqual([0, 7]);

  const prefix = rankHistory(items, "deploy");
  expect(prefix[0]?.text).toBe("deploy production");
  expect(fuzzyMatch("debug parser", "dpr")?.positions).toEqual([0, 6, 8]);
});

test("uses recency for empty queries and relevance ties", () => {
  const items: HistoryItem[] = [
    { text: "same match", source: "message", recency: 0 },
    { text: "same match!", source: "message", recency: 1 },
  ];
  expect(rankHistory(items, "").map((item) => item.recency)).toEqual([0, 1]);
  expect(rankHistory(items, "same")[0]?.recency).toBe(0);
});

test("normalizes display text and seeds only safe short single-line drafts", () => {
  expect(displayHistoryText(" first\n\tsecond\u0007 ")).toBe("first second");
  expect(initialHistoryQuery("fix parser")).toBe("fix parser");
  expect(initialHistoryQuery("line one\nline two")).toBe("");
  expect(initialHistoryQuery("x".repeat(161))).toBe("");
});
