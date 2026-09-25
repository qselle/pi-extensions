import { describe, expect, test } from "bun:test";
import { closeDanglingLink, hasDanglingLink } from "../../lib/links.ts";
import {
	boundTail,
	compactPath,
	countNonEmptyLines,
	diffStat,
	fileLink,
	fileUri,
	firstLine,
	labelText,
	resultText,
	searchTarget,
	summarize,
	targetFor,
	toAbs,
	verbFor,
} from "./render.ts";

describe("verbFor / targetFor", () => {
	test("verbs are Codex-style past-tense actions", () => {
		expect(verbFor("read")).toBe("Read");
		expect(verbFor("bash")).toBe("Ran");
		expect(verbFor("grep")).toBe("Searched");
	});
	test("targets come from args", () => {
		expect(targetFor("edit", { path: "src/auth.ts" })).toBe("src/auth.ts");
		expect(targetFor("grep", { pattern: "verify\\(" })).toBe("verify\\(");
		expect(targetFor("bash", { command: "bun test\nsecond line" })).toBe("bun test");
		expect(targetFor("ls", {})).toBe(".");
	});
});

describe("firstLine", () => {
	test("returns the first physical line", () => {
		expect(firstLine("a\nb\nc")).toBe("a");
		expect(firstLine("solo")).toBe("solo");
	});
});

test("path headlines preserve the filename instead of only a shared directory prefix", () => {
	expect(compactPath("src/nested/components/different/file.ts", 22)).toEndWith("/file.ts");
	expect(compactPath("src/nested/components/different/file.ts", 22)).toContain("…");
	expect(compactPath("src/file.ts", 40)).toBe("src/file.ts");
	expect(compactPath("C:\\work\\long\\directory\\file.ts", 18)).toEndWith("\\file.ts");
	expect(compactPath("src/very-long-filename.extension", 12)).toEndWith("nsion");
	expect(compactPath("\x1b[31msrc/file.ts\x1b[0m", 40)).toBe("src/file.ts");
	expect(compactPath("src/file.ts", 0)).toBe("");
});

describe("resultText", () => {
	test("handles string and array content, flags images", () => {
		expect(resultText({ content: "hello" })).toEqual({ text: "hello", hasImage: false });
		expect(
			resultText({
				content: [
					{ type: "text", text: "a" },
					{ type: "image", data: "..." },
				],
			}),
		).toEqual({ text: "a", hasImage: true });
	});
});

describe("countNonEmptyLines / diffStat", () => {
	test("counts non-empty lines", () => {
		expect(countNonEmptyLines("a\n\nb\n  \nc")).toBe(3);
		expect(countNonEmptyLines("")).toBe(0);
	});
	test("counts patch additions/removals, ignoring headers", () => {
		const patch = ["--- a", "+++ b", "@@ -1 +1 @@", "-old", "+new", "+another", " ctx"].join("\n");
		expect(diffStat(patch)).toEqual({ added: 2, removed: 1 });
	});
});

describe("summarize", () => {
	test("pluralizes per tool", () => {
		expect(summarize("read", { content: "a\nb\nc" }, {})).toBe("3 lines");
		expect(summarize("read", { content: "only" }, {})).toBe("1 line");
		expect(summarize("ls", { content: "a\nb" }, {})).toBe("2 entries");
		expect(summarize("grep", { content: "m1\nm2\nm3" }, {})).toBe("3 matches");
		expect(summarize("find", { content: "x" }, {})).toBe("1 result");
	});
	test("read flags images", () => {
		expect(summarize("read", { content: [{ type: "image" }] }, {})).toBe("image");
	});
	test("native empty searches and directories report zero", () => {
		expect(summarize("grep", { content: "No matches found" }, {})).toBe("0 matches");
		expect(summarize("find", { content: "No files found matching pattern" }, {})).toBe("0 results");
		expect(summarize("ls", { content: "(empty directory)" }, {})).toBe("0 entries");
	});
	test("grep counts matching lines and distinct files, excluding context and notices", () => {
		const content = "src/a.ts-1- context\nsrc/a.ts:2: match\nsrc/a.ts-3- context\nsrc/a.ts:4: another\nsrc/b.ts:7: match\n\n[3 matches limit reached. Use limit=6 for more, or refine pattern]";
		expect(summarize("grep", { content, details: { matchLimitReached: 3 } }, {})).toBe("3 matches · 2 files · limited");
		expect(summarize("grep", { content: "src/a.ts-1- context", details: { truncation: { truncated: true } } }, {})).toBe("0 matches · limited");
	});
	test("read counts blank lines and native truncation without counting continuation instructions", () => {
		expect(summarize("read", { content: "a\n\nb\n\n[8 more lines in file. Use offset=4 to continue.]" }, {})).toBe("3 lines");
		expect(summarize("read", { content: "a\n\nb", details: { truncation: { truncated: true, outputLines: 3 } } }, {})).toBe("3 lines · limited");
		expect(summarize("read", { content: "[Line 1 exceeds limit]", details: { truncation: { truncated: true, outputLines: 0 } } }, {})).toBe("0 lines · limited");
	});
	test("limited listings do not count the tool's appended notice", () => {
		expect(summarize("find", { content: "a.ts\nb.ts\n\n[2 results limit reached]", details: { resultLimitReached: 2 } }, {})).toBe("2 results · limited");
		expect(summarize("ls", { content: "a.ts\n\n[50KB limit reached]", details: { truncation: { truncated: true } } }, {})).toBe("1 entry · limited");
	});
	test("write uses args.content line count", () => {
		expect(summarize("write", { content: "" }, { content: "a\nb\nc" })).toBe("3 lines");
		expect(summarize("write", { content: "" }, {})).toBe("written");
	});
	test("edit reports +added -removed from the patch", () => {
		const patch = ["@@", "-a", "+b", "+c"].join("\n");
		expect(summarize("edit", { details: { patch } }, {})).toBe("+2 -1");
	});
	test("bash defers to its own body", () => {
		expect(summarize("bash", { content: "out" }, {})).toBe("");
	});
});

test("search labels preserve scope and glob without terminal controls or extra rows", () => {
	expect(searchTarget({ pattern: "getUser", path: "src", glob: "*.ts" })).toBe('"getUser" in src (*.ts)');
	expect(searchTarget({ pattern: "a\nb", path: "." })).toBe('"a b"');
	expect(labelText("a\x1b[31mb\x1b[0m\n c")).toBe("ab c");
});

describe("boundTail", () => {
	test("keeps the tail and reports omitted count", () => {
		expect(boundTail("1\n2\n3\n4\n5", 2)).toEqual({ lines: ["4", "5"], omitted: 3 });
		expect(boundTail("1\n2", 5)).toEqual({ lines: ["1", "2"], omitted: 0 });
	});
});

describe("file links", () => {
	test("toAbs resolves relative paths against cwd", () => {
		expect(toAbs("x.ts", "/home/u")).toBe("/home/u/x.ts");
		expect(toAbs("/abs/x.ts", "/home/u")).toBe("/abs/x.ts");
	});
	test("fileUri percent-encodes", () => {
		expect(fileUri("/a/b c.ts")).toBe("file:///a/b%20c.ts");
	});
	test("fileLink wraps display and always closes the link", () => {
		const link = fileLink("src", "/a/src");
		expect(link).toBe("\x1b]8;;file:///a/src\x1b\\src\x1b]8;;\x1b\\");
		expect(link.endsWith("\x1b]8;;\x1b\\")).toBe(true);
	});

	test("width-fitting a linked line would strand the link without repair", () => {
		// This mirrors `fit()` in index.ts: Lines.render re-fits every built line, and
		// truncation keeps the zero-width opener while dropping the terminator. The
		// truncated bytes are written out literally because other test files mock
		// pi-tui process-wide.
		const truncated = "\x1b]8;;file:///a/src/long.ts\x1b\\src/lo\u2026";
		expect(hasDanglingLink(truncated)).toBe(true);

		const repaired = closeDanglingLink(truncated);
		expect(hasDanglingLink(repaired)).toBe(false);
		expect(repaired.startsWith(truncated)).toBe(true);
	});
});
