import { describe, expect, test } from "bun:test";
import {
	boundTail,
	countNonEmptyLines,
	diffStat,
	fileLink,
	fileUri,
	firstLine,
	resultText,
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
});
