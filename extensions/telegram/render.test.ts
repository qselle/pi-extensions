import { expect, test } from "bun:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { MAX_NOTIFICATION_ROWS, notificationResult } from "./render.ts";

initTheme("dark", false);
// Zero-width color codes, so styling does not change the wrapped width.
const codes: Record<string, string> = { muted: "\x1b[90m", border: "\x1b[37m", error: "\x1b[91m" };
const theme = { fg: (color: string, value: string) => `${codes[color] ?? ""}${value}\x1b[39m` };
const plain = (rows: string[]) => rows.map((row) => stripVTControlCharacters(row).trimEnd());

test("shows the sent message as formatted Markdown under a gutter", () => {
  const rows = notificationResult("# Done\n\n**Report** ready\n\n- one\n- `two`", undefined, theme).render(60);
  expect(plain(rows)).toEqual(["  │ Done", "  │", "  │ Report ready", "  │", "  │ - one", "  │ - two"]);
  expect(rows.join("\n")).not.toContain("**");
  expect(rows[2]).toContain(codes.muted);
});

test("settled rows are cached per width and stable across frames", () => {
  const component = notificationResult("one two three four five six seven", undefined, theme);
  const first = component.render(14);
  expect(component.render(14)).toBe(first);
  expect(plain(first).length).toBeGreaterThan(1);
  expect(plain(component.render(80))).toEqual(["  │ one two three four five six seven"]);
});

test("long messages show in full without expansion, up to a safety bound", () => {
  const message = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n\n");
  const rows = plain(notificationResult(message, undefined, theme, false, getMarkdownTheme()).render(60)).filter((row) => row !== "  │");
  expect(rows).toHaveLength(30);
  expect(rows.at(-1)).toBe("  │ line 30");
  const huge = Array.from({ length: MAX_NOTIFICATION_ROWS + 5 }, (_, index) => `${index}`).join("\n\n");
  expect(plain(notificationResult(huge, undefined, theme).render(60)).at(-1)).toContain("more lines · preview limit");
});

test("errors render below the message and terminal controls are stripped", () => {
  const rows = notificationResult("Hello\x1b[31m red\x07", "Telegram rejected the request (HTTP 403).", theme).render(60);
  expect(plain(rows)).toEqual(["  │ Hello red", "  Telegram rejected the request (HTTP 403)."]);
  expect(rows[1]).toContain(codes.error);
  expect(rows.join("")).not.toContain("\x1b[31m");
});
