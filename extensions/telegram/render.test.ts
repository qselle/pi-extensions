import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { COLLAPSED_NOTIFICATION_ROWS, notificationResult } from "./render.ts";

const theme = { fg: (color: string, value: string) => `<${color}>${value}</${color}>` };
const plain = (rows: string[]) => rows.map((row) => stripVTControlCharacters(row).replace(/<\/?\w+>/g, "").trimEnd());

test("shows every line of a short sent message under a gutter", () => {
  const rows = notificationResult("# Done\n\n**Report** ready", undefined, theme, false).render(60);
  expect(plain(rows)).toEqual(["  │ # Done", "  │", "  │ **Report** ready"]);
  expect(rows[0]).toContain("<muted># Done</muted>");
});

test("settled rows are cached per width and stable across frames", () => {
  const component = notificationResult("one two three four five six seven", undefined, theme, false);
  const first = component.render(14);
  expect(component.render(14)).toBe(first);
  expect(plain(first).length).toBeGreaterThan(1);
  expect(plain(component.render(80))).toEqual(["  │ one two three four five six seven"]);
});

test("long messages are bounded collapsed and expanded", () => {
  const message = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
  const collapsed = plain(notificationResult(message, undefined, theme, false).render(60));
  expect(collapsed).toHaveLength(COLLAPSED_NOTIFICATION_ROWS + 1);
  expect(collapsed.at(-1)).toContain("… 18 more lines");
  const expanded = plain(notificationResult(message, undefined, theme, true).render(60));
  expect(expanded).toHaveLength(30);
  expect(expanded.at(-1)).toBe("  │ line 30");
});

test("errors render below the message and terminal controls are stripped", () => {
  const rows = notificationResult("Hello\x1b[31m red\x07", "Telegram rejected the request (HTTP 403).", theme, false).render(60);
  expect(plain(rows)).toEqual(["  │ Hello red", "  Telegram rejected the request (HTTP 403)."]);
  expect(rows[1]).toContain("<error>");
  expect(rows.join("")).not.toContain("\x1b[31m");
});
