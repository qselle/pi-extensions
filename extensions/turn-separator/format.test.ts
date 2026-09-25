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
			expect(line).toBe("─".repeat(Math.max(0, width - 2)));
		}
		for (const width of [-1, NaN, Infinity]) expect(separatorText(74, width)).toBe("");
		expect(separatorText(74, 3.5)).toBe("─");
	});
	test("labels long steps and keeps a 2-column right margin", () => {
		const line = separatorText(74, 40);
		expect(line).toContain("Worked for 1m 14s");
		expect([...line].length).toBe(38);
	});
	test("short and unknown work stays a bare rule", () => {
		expect(separatorText(0, 20)).toBe("─".repeat(18));
		expect(separatorText(59, 20)).toBe("─".repeat(18));
		expect(separatorText(undefined, 20)).toBe("─".repeat(18));
	});
	test("falls back to a bare rule when too narrow for the label", () => {
		expect(separatorText(74, 10)).toBe("─".repeat(8));
	});
	test("right-aligned timing wins over the elapsed label at narrow widths", () => {
		const timing = { ttftMs: 480, tps: 42 };
		expect(separatorText(74, 100, timing)).toMatch(/Worked for 1m 14s .*first token 480ms · 42 tokens\/s ─$/);
		expect(separatorText(74, 40, timing)).not.toContain("Worked for");
		expect(separatorText(74, 20, timing)).toContain("42 tokens/s");
		for (let width = 1; width < 120; width++) expect(separatorText(74, width, timing).length).toBe(Math.max(0, width - 2));
	});
});
