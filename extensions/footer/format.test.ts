import { describe, expect, test } from "bun:test";
import {
	buildCells,
	compactInlineText,
	contextColor,
	displayModelId,
	fitCells,
	formatCost,
	formatCwd,
	formatPercent,
	formatTokens,
	layoutFooter,
	modelLabel,
	sanitizeStatusText,
	statusLine,
	workspaceLabel,
	type FooterInput,
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
	test("formatCwd collapses Unix and Windows homes and workspaceLabel appends git", () => {
		expect(formatCwd("/Users/q/private", "/Users/q")).toBe("~/private");
		expect(formatCwd("C:\\Users\\q\\private", "C:\\Users\\q")).toBe("~\\private");
		expect(workspaceLabel("~/private", "main")).toBe("~/private · main");
		expect(workspaceLabel("~/private", null)).toBe("~/private");
	});
});

const sample = (): FooterInput => ({
	session: "Refactor auth",
	model: "claude-opus-4-8 max",
	badges: ["fast"],
	status: "ready",
	usage: { tokens: 28_200, contextWindow: 258_000, percent: 6 },
	totals: { input: 96_000, output: 521, cost: 0.21 },
});

describe("buildCells", () => {
	test("produces a compact identity, state, context, and usage rail", () => {
		const cells = buildCells(sample());
		expect(cells.map((cell) => cell.id)).toEqual([
			"session",
			"model",
			"badges",
			"status",
			"context",
			"contextTokens",
			"traffic",
			"cost",
		]);
		expect(cells.map((cell) => cell.text)).toEqual([
			"Refactor auth",
			"claude-opus-4-8 max",
			"[fast]",
			"● ready",
			"ctx 94% left",
			"28.2K/258K",
			"↓96K ↑521",
			"$0.21",
		]);
	});

	test("omits empty optional cells and marks unknown context", () => {
		const cells = buildCells({
			model: "m",
			status: "working",
			usage: { tokens: null, contextWindow: 258_000, percent: null },
			totals: { input: 0, output: 0, cost: 0 },
		});
		expect(cells.some((cell) => cell.id === "session")).toBe(false);
		expect(cells.some((cell) => cell.id === "badges")).toBe(false);
		expect(cells.some((cell) => cell.id === "traffic")).toBe(false);
		expect(cells.some((cell) => cell.id === "cost")).toBe(false);
		expect(cells.find((cell) => cell.id === "context")?.text).toBe("ctx ?% left");
		expect(cells.find((cell) => cell.id === "contextTokens")?.text).toBe("?/258K");
	});
});

describe("responsive layout", () => {
	test("long model identities cannot push context outside narrow terminals", () => {
		const cells = buildCells({ ...sample(), model: "routed.provider.".repeat(12) });
		for (let width = 1; width <= 120; width++) {
			const layout = layoutFooter(cells, "~/project · main", width);
			const line = layout.cells.map((cell) => cell.text).join(" · ")
				+ " ".repeat(layout.gap) + layout.workspace;
			expect([...line].length).toBeLessThanOrEqual(width);
			if (width >= 16) expect(line).toContain("ctx 94% left");
		}
		expect(cells[1]!.text).toBe("routed.provider.".repeat(12));
	});

	test("uses display widths when shortening wide Unicode labels", () => {
		const measure = (s: string) => [...s].reduce((n, c) => n + (c === "界" ? 2 : 1), 0);
		for (let width = 1; width <= 80; width++) {
			const layout = layoutFooter(buildCells({ ...sample(), model: "界".repeat(60) }), "界".repeat(30), width, " · ", measure);
			expect(measure(layout.cells.map((cell) => cell.text).join(" · ")) + layout.gap + measure(layout.workspace)).toBeLessThanOrEqual(width);
		}
	});

	test("context pressure has distinct healthy, warning, critical and unknown states", () => {
		expect(contextColor(74)).toBe("success");
		expect(contextColor(75)).toBe("warning");
		expect(contextColor(90)).toBe("error");
		expect(contextColor(null)).toBe("muted");
		expect(contextColor(NaN)).toBe("muted");
	});
	test("fitCells removes detail while retaining model and remaining context", () => {
		expect(fitCells(buildCells(sample()), 300).length).toBe(8);
		const kept = fitCells(buildCells(sample()), 55);
		expect(kept.some((cell) => cell.id === "traffic")).toBe(false);
		expect(kept.some((cell) => cell.id === "session")).toBe(false);
		expect(kept.some((cell) => cell.id === "model")).toBe(true);
		expect(kept.some((cell) => cell.id === "context")).toBe(true);
	});

	test("anchors the workspace at the right edge when it fits", () => {
		const width = 120;
		const separator = " · ";
		const layout = layoutFooter(buildCells(sample()), "~/src/pi-extensions · main", width, separator);
		const leftWidth = layout.cells.reduce((total, cell) => total + [...cell.text].length, 0)
			+ separator.length * Math.max(0, layout.cells.length - 1);
		expect(leftWidth + layout.gap + [...layout.workspace].length).toBe(width);
		expect(layout.workspace).toBe("~/src/pi-extensions · main");
		expect(layout.gap).toBeGreaterThanOrEqual(2);
	});

	test("preserves repository and branch identity when shortening the workspace", () => {
		const layout = layoutFooter(
			buildCells(sample()),
			"~/src/company/platform/pi-extensions · feature/very-long-branch-name",
			82,
		);
		expect(layout.workspace).toContain("pi-extensions");
		expect(layout.workspace).toContain("feature/");
		expect([...layout.workspace].length).toBeLessThanOrEqual(Math.floor(82 * 0.42));
	});
});

describe("compactInlineText", () => {
	test("removes terminal controls, flattens whitespace, and bounds labels", () => {
		expect(compactInlineText("\u001b[31m fast\nmode \u001b[0m", 20)).toBe("fast mode");
		expect(compactInlineText("abcdefghijkl", 8)).toBe("abcdefg…");
		expect(compactInlineText(undefined, 8)).toBe("");
	});
});

describe("statusLine", () => {
	test("sorts by key so the order does not depend on which extension reported first", () => {
		const line = statusLine([
			["subagents-usage", "agents ↑12k"],
			["verify", "verifying tests…"],
			["session-search", "loading sessions 25/120…"],
		]);
		expect(line).toBe("loading sessions 25/120… · agents ↑12k · verifying tests…");
	});

	test("sanitizes one status text the way pi does", () => {
		expect(sanitizeStatusText(" a\tb\r\nc  d ")).toBe("a b c d");
	});

	test("flattens multi-line status text and collapses runs of spaces", () => {
		expect(statusLine([["a", "line one\nline\ttwo   three\r\n"]])).toBe("line one line two three");
	});

	test("keeps styling intact", () => {
		expect(statusLine([["a", "\u001b[2mdim status\u001b[0m"]])).toBe("\u001b[2mdim status\u001b[0m");
	});

	test("skips entries that sanitize to nothing and reports nothing when empty", () => {
		expect(statusLine([["a", "   "], ["b", "real"]])).toBe("real");
		expect(statusLine([])).toBe("");
		expect(statusLine(undefined)).toBe("");
	});

	test("accepts a themed separator", () => {
		expect(statusLine([["a", "one"], ["b", "two"]], " | ")).toBe("one | two");
	});

	test("reads a ReadonlyMap straight from pi's footer data provider", () => {
		const statuses: ReadonlyMap<string, string> = new Map([["b", "second"], ["a", "first"]]);
		expect(statusLine(statuses)).toBe("first · second");
	});
});
