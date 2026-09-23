import { describe, expect, test } from "bun:test";
import {
	compactInlineText,
	contextColor,
	displayModelId,
	fitCells,
	formatCost,
	formatCwd,
	formatPercent,
	formatTokens,
	modelLabel,
} from "./format.ts";

describe("formatTokens", () => {
	test("formats across magnitudes", () => {
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

describe("model + workspace", () => {
	test("displayModelId shows the id as-is", () => {
		expect(displayModelId("global.anthropic.claude-opus-4-8")).toBe("global.anthropic.claude-opus-4-8");
		expect(displayModelId(undefined)).toBe("no-model");
	});
	test("modelLabel appends effort unless off", () => {
		expect(modelLabel("global.anthropic.claude-opus-4-8", "max")).toBe("global.anthropic.claude-opus-4-8 max");
		expect(modelLabel("global.anthropic.claude-opus-4-8", "off")).toBe("global.anthropic.claude-opus-4-8");
	});
	test("formatCwd collapses Unix and Windows homes", () => {
		expect(formatCwd("/Users/q/private", "/Users/q")).toBe("~/private");
		expect(formatCwd("C:\\Users\\q\\private", "C:\\Users\\q")).toBe("~\\private");
	});
});

test("fitCells retains required values while dropping secondary data", () => {
  const cells = [{ text: "required", priority: 0 }, { text: "extra", priority: 1 }];
  expect(fitCells(cells, 10)).toEqual([cells[0]!]);
  expect(cells).toHaveLength(2);
});

test("context pressure distinguishes healthy, warning, critical and unknown", () => {
  expect(contextColor(74)).toBe("success");
  expect(contextColor(75)).toBe("warning");
  expect(contextColor(90)).toBe("error");
  expect(contextColor(null)).toBe("muted");
  expect(contextColor(NaN)).toBe("muted");
});

describe("compactInlineText", () => {
	test("removes terminal controls, flattens whitespace, and bounds labels", () => {
		expect(compactInlineText("\u001b[31m fast\nmode \u001b[0m", 20)).toBe("fast mode");
		expect(compactInlineText("abcdefghijkl", 8)).toBe("abcdefg…");
		expect(compactInlineText(undefined, 8)).toBe("");
	});
});


test("inline text preserves hyperlink labels while stripping OSC, CSI and C1 controls", () => {
  expect(compactInlineText("link \x1b]8;;https://example.com\x1b\\important\x1b]8;;\x1b\\ tail", 100)).toBe("link important tail");
  expect(compactInlineText("\x9d2;secret title\x9cvisible \x9b31mred\x9b0m", 100)).toBe("visible red");
});
