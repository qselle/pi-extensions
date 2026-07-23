import { describe, expect, test } from "bun:test";
import { contentToAddRows, gutterWidth, parseUnifiedPatch, washLine } from "./diff.ts";

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

describe("washLine", () => {
	const BG = "\x1b[48;2;1;2;3m";
	test("re-injects the background after inner resets and pads to width", () => {
		const out = washLine(BG, "\x1b[38;2;9;9;9mX\x1b[0mY", 2, 4);
		expect(out.startsWith(BG)).toBe(true);
		expect(out).toContain(`\x1b[0m${BG}`); // bg re-injected after the reset
		expect(out.endsWith(`  \x1b[0m`)).toBe(true); // padded (4 - 2) then closed
	});
});
