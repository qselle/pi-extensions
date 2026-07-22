import { describe, expect, test } from "bun:test";
import { contentToAddRows, gutterWidth, parseUnifiedPatch } from "./diff.ts";

describe("parseUnifiedPatch", () => {
	test("numbers context/add/del rows from the hunk header", () => {
		const patch = [
			"--- src/auth.ts",
			"+++ src/auth.ts",
			"@@ -1,3 +1,3 @@",
			" export function add(a, b) {",
			"-  return a - b",
			"+  return a + b",
			" }",
		].join("\n");
		expect(parseUnifiedPatch(patch)).toEqual([
			{ kind: "ctx", num: 1, content: "export function add(a, b) {" },
			{ kind: "del", num: 2, content: "  return a - b" },
			{ kind: "add", num: 2, content: "  return a + b" },
			{ kind: "ctx", num: 3, content: "}" },
		]);
	});
	test("advances numbers across a multi-line hunk and ignores no-newline markers", () => {
		const patch = ["@@ -10,2 +10,3 @@", " a", "+b", "+c", "\\ No newline at end of file", " d"].join("\n");
		expect(parseUnifiedPatch(patch)).toEqual([
			{ kind: "ctx", num: 10, content: "a" },
			{ kind: "add", num: 11, content: "b" },
			{ kind: "add", num: 12, content: "c" },
			{ kind: "ctx", num: 13, content: "d" },
		]);
	});
	test("empty patch yields no rows", () => {
		expect(parseUnifiedPatch("")).toEqual([]);
	});
});

describe("contentToAddRows", () => {
	test("numbers each written line, ignoring a trailing newline", () => {
		expect(contentToAddRows("a\nb\n")).toEqual([
			{ kind: "add", num: 1, content: "a" },
			{ kind: "add", num: 2, content: "b" },
		]);
		expect(contentToAddRows("")).toEqual([]);
	});
});

describe("gutterWidth", () => {
	test("is the widest number, at least the minimum", () => {
		expect(gutterWidth([{ kind: "ctx", num: 5, content: "" }])).toBe(2);
		expect(gutterWidth([{ kind: "ctx", num: 1234, content: "" }])).toBe(4);
	});
});
