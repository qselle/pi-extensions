import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters as plain } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { codemodeRestyler, INTENT_GUIDELINE, renderCodemodeCard, splitScript, type CodemodeCall, type CodemodeView } from "./codemode.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const render = (view: Partial<CodemodeView>, width = 80) =>
	renderCodemodeCard({ code: "return 1;", partial: false, started: true, error: false, expanded: false, ...view }, theme, width).map(plain);

const call = (args: object, extra: Partial<CodemodeCall> = {}): CodemodeCall =>
	({ id: "c/1", name: "bash", args: JSON.stringify(args), status: "ok", ...extra });

function settled(text: string, calls: CodemodeCall[], ok = true, seconds = 2.4) {
	return {
		content: [
			{ type: "text", text: `Script ${ok ? "completed" : "failed"}\nWall time ${seconds} seconds\nOutput:\n` },
			{ type: "text", text },
		],
		details: { calls },
	};
}

describe("codemode card", () => {
	test("shows intent, grouped calls and output without Pi's result header", () => {
		const calls = [
			call({ purpose: "Count commits", command: "git log" }),
			call({ purpose: "Count commits", command: "git log" }),
			call({ purpose: "Read readme", path: "README.md" }, { name: "read", durationMs: 1_500 }),
		];
		const code = '// @options: {"timeout_ms": 1000}\n// Collect repo stats.\nconst a = 1;\nreturn a;';
		const lines = render({ code, result: settled("| a | b |", calls) });

		expect(lines[0]).toBe("• Ran script to collect repo stats · 3 calls · ✓ in 2s");
		expect(lines.join("\n")).toContain("const a = 1;");
		expect(lines.join("\n")).not.toContain("@options");
		expect(lines.join("\n")).not.toContain("// Collect");
		expect(lines).toContain("  ├ bash Count commits $ git log ×2 · ✓");
		expect(lines).toContain("  ├ read Read readme README.md · ✓ in 1s");
		expect(lines.at(-1)).toBe("  └ | a | b |");
		expect(lines.join("\n")).not.toContain("Wall time");
	});

	test("shows the whole script, every call and call errors when expanded", () => {
		const code = '// @options: {"timeout_ms": 1000}\n// Fan out.\nreturn 1;';
		const calls = [call({ purpose: "Sleep", command: "sleep 1" }), call({ purpose: "Sleep", command: "sleep 2" }, { status: "error", error: "exit 2" })];
		const result = { ...settled("Script error:\nboom", calls, false), isError: true };
		const collapsed = render({ code, result, error: true });
		const expanded = render({ code, result, error: true, expanded: true });

		expect(collapsed[0]).toBe("• Script failed to fan out · 2 calls · ✗ in 2s");
		expect(collapsed).toContain("  ├ bash Sleep $ sleep 1 (+1) · ✗ 1");
		expect(collapsed.join("\n")).not.toContain("exit 2");
		expect(expanded.join("\n")).toContain("@options");
		expect(expanded.join("\n")).toContain("// Fan out.");
		expect(expanded).toContain("  ├ bash Sleep $ sleep 1 · ✓");
		expect(expanded).toContain("  ├ bash Sleep $ sleep 2 · ✗");
		expect(expanded).toContain("      exit 2");
		expect(expanded.at(-1)).toBe("    boom");
	});

	test("prefers the script's wall time and falls back to Pi's recorded duration", () => {
		expect(render({ result: settled("ok", []), durationMs: 9_000 })[0]).toBe("• Ran script · ✓ in 2s");
		const unstarted = { content: [{ type: "text", text: "No codemode worker became free within 60 seconds" }], details: { calls: [] }, isError: true };
		expect(render({ result: unstarted, error: true, durationMs: 61_000 })[0]).toBe("• Script failed · ✗ in 1m 1s");
	});

	test("shows running calls without output while partial", () => {
		const result = { content: [], details: { calls: [call({ purpose: "Scan shard", command: "ls" }, { status: "running" })] } };
		const lines = render({ partial: true, result });

		expect(lines[0]).toBe("• Running script · 1 call");
		expect(lines.at(-1)).toBe("  └ bash Scan shard $ ls · …");
		expect(render({ partial: true, started: false })[0]).toBe("• Script");
	});

	test("labels truncated calls with the masked main argument", () => {
		// Pi's preview: JSON.stringify(args) cut to 197 characters plus "...".
		const full = JSON.stringify({
			command: `AWS_SECRET_ACCESS_KEY='sbXD5/jtw' aws s3 ls --endpoint-url "https://x" ${"a".repeat(200)}`,
			purpose: "List buckets",
		});
		const calls = [{ id: "c/1", name: "bash", args: `${full.slice(0, 197)}...`, status: "ok" as const }];
		const text = render({ result: settled("", calls) }, 300).join("\n");

		expect(text).toContain(`bash $ AWS_SECRET_ACCESS_KEY=*** aws s3 ls --endpoint-url "https://x" aaa`);
		expect(text).toContain("a… · ✓");
		expect(text).not.toContain("sbXD5");
		expect(text).not.toContain('{"command"');
	});

	test("prefers purpose over saved reasoning and keeps unknown argument shapes", () => {
		const lines = render({ result: settled("", [
			call({ reasoning: "Old caption", command: "pwd" }),
			call({ id: 1, nested: true }, { name: "job_status" }),
		]) });

		expect(lines).toContain("  ├ bash Old caption $ pwd · ✓");
		// Without output, the last call closes the tree.
		expect(lines).toContain('  └ job_status {"id":1,"nested":true} · ✓');
	});

	test("collapses long call lists and keeps every row within the width", () => {
		const calls = Array.from({ length: 20 }, (_, index) => call({ purpose: `Step ${index} with a long explanation that wraps`, command: "true" },
			index === 0 ? { status: "error" } : {}));
		const lines = renderCodemodeCard({ code: "return 1;", result: settled("x".repeat(300), calls), partial: false, started: true, error: false, expanded: false }, theme, 40);

		expect(plain(lines.find((line) => line.includes("earlier")) ?? "")).toStartWith("  ├ … +15 earlier calls (1 failed)");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});
});

describe("splitScript", () => {
	test("reads the intent after the options pragma and keeps acronyms", () => {
		expect(splitScript('// @options: {"timeout_ms": 1}\n\n// Check S3 buckets.\nreturn 1;')).toEqual({ intent: "check S3 buckets", body: "return 1;" });
		expect(splitScript("// API audit\nreturn 1;").intent).toBe("API audit");
		expect(splitScript("return 1; // trailing").intent).toBe("");
	});
});

describe("codemode registration", () => {
	function fakePi(sourcePath: string | undefined) {
		const registered: any[] = [];
		const pi: any = {
			getAllTools: () => (sourcePath ? [{ name: "codemode", sourceInfo: { path: sourcePath } }] : []),
			registerTool: (definition: any) => registered.push(definition),
			getSettings: () => ({ codemode: { mode: "only" } }),
		};
		return { pi, registered };
	}
	const create = () => (pi: any) => pi.registerTool({ name: "codemode", execute: () => "ran", defaultActive: false, mode: pi.getSettings().codemode.mode });

	test("restyles Pi's built-in tool once and keeps its definition and settings", () => {
		const { pi, registered } = fakePi("builtin:codemode");
		const restyle = codemodeRestyler(pi, create);
		restyle();
		restyle();

		expect(registered).toHaveLength(1);
		expect(registered[0]).toMatchObject({ name: "codemode", renderShell: "self", defaultActive: false, mode: "only" });
		expect(registered[0].promptGuidelines).toEqual([INTENT_GUIDELINE]);
		expect(registered[0].execute()).toBe("ran");
	});

	test("leaves disabled or third-party codemode tools alone", () => {
		for (const source of [undefined, "/ext/other-codemode.ts"]) {
			const { pi, registered } = fakePi(source);
			codemodeRestyler(pi, create)();
			expect(registered).toHaveLength(0);
		}
	});
});
