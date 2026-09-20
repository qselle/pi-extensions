import { expect, test } from "bun:test";
import { OutputLog, PlainOutput } from "../../lib/output.ts";

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
