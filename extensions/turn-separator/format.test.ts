import { describe, expect, test } from "bun:test";
import { formatDuration, separatorText } from "./format.ts";

describe("formatDuration", () => {
	test("formats seconds, minutes, and hours", () => {
		expect(formatDuration(3)).toBe("3s");
		expect(formatDuration(59)).toBe("59s");
		expect(formatDuration(74)).toBe("1m 14s");
		expect(formatDuration(120)).toBe("2m");
		expect(formatDuration(3600)).toBe("1h");
		expect(formatDuration(3661)).toBe("1h 1m");
	});
});

describe("separatorText", () => {
	test("fits collapsed viewports without creating a minimum four-column rule", () => {
		for (const width of [0, 1, 2, 3, 4, 5]) {
			const line = separatorText(74, width);
			expect(line).toBe("─".repeat(width <= 1 ? width : width - 1));
		}
		for (const width of [-1, NaN, Infinity]) expect(separatorText(74, width)).toBe("");
		expect(separatorText(74, 3.5)).toBe("──");
	});
	test("labels the rule and keeps a 1-column right margin", () => {
		const line = separatorText(74, 40);
		expect(line).toContain("Worked for 1m 14s");
		expect([...line].length).toBe(39); // width - 1
	});
	test("bare rule for sub-second work or unknown duration", () => {
		expect(separatorText(0, 20)).toBe("─".repeat(19));
		expect(separatorText(undefined, 20)).toBe("─".repeat(19));
	});
	test("falls back to a bare rule when too narrow for the label", () => {
		expect(separatorText(74, 10)).toBe("─".repeat(9));
	});
});
