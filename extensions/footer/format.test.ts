import { describe, expect, test } from "bun:test";
import {
	buildCells,
	fitCells,
	displayModelId,
	formatCost,
	formatCwd,
	formatPercent,
	formatTokens,
	modelLabel,
	type FooterInput,
} from "./format.ts";

describe("formatTokens", () => {
	test("formats across magnitudes like the Codex line", () => {
		expect(formatTokens(521)).toBe("521");
		expect(formatTokens(96_000)).toBe("96K");
		expect(formatTokens(28_200)).toBe("28.2K");
		expect(formatTokens(258_000)).toBe("258K");
		expect(formatTokens(2_350_000)).toBe("2.35M");
	});
	test("returns ? when unknown", () => {
		expect(formatTokens(null)).toBe("?");
	});
});

describe("formatPercent / formatCost", () => {
	test("percent rounds; ? when unknown", () => {
		expect(formatPercent(94)).toBe("94%");
		expect(formatPercent(5.7)).toBe("6%");
		expect(formatPercent(null)).toBe("?%");
	});
	test("cost", () => {
		expect(formatCost(0.21)).toBe("$0.21");
		expect(formatCost(0.004)).toBe("$0.004");
	});
});

describe("model + cwd", () => {
	test("displayModelId shows the id as-is (routing prefix + provider kept)", () => {
		expect(displayModelId("global.anthropic.claude-opus-4-8")).toBe("global.anthropic.claude-opus-4-8");
		expect(displayModelId(undefined)).toBe("no-model");
	});
	test("modelLabel appends effort unless off", () => {
		expect(modelLabel("global.anthropic.claude-opus-4-8", "max")).toBe("global.anthropic.claude-opus-4-8 max");
		expect(modelLabel("global.anthropic.claude-opus-4-8", "off")).toBe("global.anthropic.claude-opus-4-8");
	});
	test("formatCwd collapses home to ~", () => {
		expect(formatCwd("/Users/q/private", "/Users/q")).toBe("~/private");
	});
});

const sample = (): FooterInput => ({
	model: "claude-opus-4-8 max",
	dir: "~/private",
	status: "Ready",
	usage: { tokens: 28_200, contextWindow: 258_000, percent: 6 },
	totals: { input: 96_000, output: 521, cost: 0.21 },
});

describe("buildCells", () => {
	test("produces the Codex order and text", () => {
		const cells = buildCells(sample());
		expect(cells.map((c) => c.id)).toEqual([
			"model",
			"dir",
			"status",
			"left",
			"used",
			"window",
			"usedTok",
			"in",
			"out",
			"cost",
		]);
		expect(cells.map((c) => c.text)).toEqual([
			"claude-opus-4-8 max",
			"~/private",
			"Ready",
			"Context 94% left",
			"Context 6% used",
			"258K window",
			"28.2K used",
			"96K in",
			"521 out",
			"$0.21",
		]);
	});
	test("omits cost when zero and marks unknown context", () => {
		const cells = buildCells({
			model: "m",
			dir: "d",
			status: "Ready",
			usage: { tokens: null, contextWindow: 258_000, percent: null },
			totals: { input: 0, output: 0, cost: 0 },
		});
		expect(cells.some((c) => c.id === "cost")).toBe(false);
		expect(cells.find((c) => c.id === "left")!.text).toBe("Context ?% left");
		expect(cells.find((c) => c.id === "usedTok")!.text).toBe("? used");
	});
});

describe("fitCells", () => {
	test("keeps everything when width is ample", () => {
		expect(fitCells(buildCells(sample()), 300).length).toBe(10);
	});
	test("drops cost first, then tail fields; keeps model + % left longest", () => {
		expect(fitCells(buildCells(sample()), 129).map((c) => c.id)).not.toContain("cost");
		expect(fitCells(buildCells(sample()), 38).map((c) => c.id)).toEqual(["model", "left"]);
		expect(fitCells(buildCells(sample()), 20).map((c) => c.id)).toEqual(["model"]);
	});
});
