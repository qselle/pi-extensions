import { describe, expect, test } from "bun:test";
import { isPlainRule, stripAnsi, transformEditorLines } from "./transform.ts";

describe("stripAnsi / isPlainRule", () => {
	test("strips SGR and OSC 8", () => {
		expect(stripAnsi("\x1b[36m─\x1b[0m")).toBe("─");
	});
	test("detects plain rules but not scroll indicators or text", () => {
		expect(isPlainRule("─".repeat(10))).toBe(true);
		expect(isPlainRule("  ─── ")).toBe(true);
		expect(isPlainRule("─── ↑ 3 more ───")).toBe(false);
		expect(isPlainRule("hello")).toBe(false);
		expect(isPlainRule("")).toBe(false);
		expect(isPlainRule("   ")).toBe(false); // spaces only, no rule
	});
});

describe("transformEditorLines", () => {
	test("injects the prompt on the first content line, keeping the rules", () => {
		const lines = ["\x1b[2m──────────\x1b[0m", "  hello world", "\x1b[2m──────────\x1b[0m"];
		expect(transformEditorLines(lines, "› ")).toEqual([
			"\x1b[2m──────────\x1b[0m",
			"› hello world",
			"\x1b[2m──────────\x1b[0m",
		]);
	});
	test("keeps scroll indicators and continuation lines", () => {
		const lines = ["─── ↑ 2 more ───", "  line one", "  line two", "──────────"];
		expect(transformEditorLines(lines, "› ")).toEqual(["─── ↑ 2 more ───", "› line one", "  line two", "──────────"]);
	});
	test("empty editor shows the prompt between the rules", () => {
		expect(transformEditorLines(["──────", "  ", "──────"], "› ")).toEqual(["──────", "› ", "──────"]);
	});
	test("keeps rules around autocomplete and prompts the first entry line", () => {
		const lines = ["──────", "  /mod", "──────", "  /model", "  /models"];
		expect(transformEditorLines(lines, "› ")).toEqual(["──────", "› /mod", "──────", "  /model", "  /models"]);
	});
});
