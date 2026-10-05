import { expect, test } from "bun:test";
import { OutputLog, outputWindow, PlainOutput } from "../../lib/output.ts";

test("split terminal escape sequences never enter captured output", () => {
  const output = new PlainOutput();
  const chunks = ["normal\x1b[3", "1mred\x1b[0m\x1b]0;", "bad title\x1b", "\\safe\x1bP", "payload\x1b\\end\r", "\nline"];
  expect(chunks.map((chunk) => output.push(chunk)).join("")).toBe("normalredsafeend\nline");
});

test("absolute cursors expose eviction and return only unread output", () => {
  const log = new OutputLog(10);
  log.append("123456");
  const first = log.read(0, 4);
  expect(first).toEqual({ text: "1234", cursor: 4, lost: 0, more: true });
  log.append("7890123456");
  expect(log.read(first.cursor)).toEqual({ text: "7890123456", cursor: 16, lost: 2, more: false });
  expect(log.read(16).text).toBe("");
  expect(() => log.read(17)).toThrow();
  expect(() => log.read(-1)).toThrow();
});

test("retention and reads preserve complete Unicode characters", () => {
  const log = new OutputLog(5);
  log.append("🐈🐈🐈");
  expect(log.start).toBe(2);
  expect(log.read(0, 3)).toEqual({ text: "🐈", cursor: 4, lost: 2, more: true });
  expect(log.read(4, 3).text).toBe("🐈");
  expect(log.tail(3)).toBe("🐈");
});

test("newest-first windows end at the output end and report what they skipped", () => {
  const log = new OutputLog(100);
  log.append("0123456789".repeat(15));
  expect(log.start).toBe(50);
  const newest = log.window(0, 20, true);
  expect(newest).toEqual({ text: "01234567890123456789", cursor: 150, lost: 50, more: false, from: 50, omitted: 80 });
  expect(log.window(140, 20, true)).toEqual({ text: "0123456789", cursor: 150, lost: 0, more: false, from: 140, omitted: 0 });
  const page = log.window(60, 30);
  expect(page).toEqual({ text: "0123456789".repeat(3), cursor: 90, lost: 0, more: true, from: 60, omitted: 0 });
  expect(() => log.window(151, 20, true)).toThrow();
  expect(() => log.window(0, 1, true)).toThrow();
  // The legacy reader keeps its own limit and semantics.
  expect(() => log.read(0, 20_000)).toThrow();
});

test("windows never split a surrogate pair at either edge", () => {
  expect(outputWindow("a🐈b", 10, 10, 2, true)).toEqual({ text: "b", cursor: 14, lost: 0, more: false, from: 10, omitted: 3 });
  expect(outputWindow("🐈🐈", 0, 0, 3, false).text).toBe("🐈");
  expect(outputWindow("🐈🐈", 0, 1, 4, true)).toMatchObject({ text: "🐈", from: 2, lost: 1 });
});
