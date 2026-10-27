import { describe, expect, test } from "bun:test";
import { formatShellCommand } from "./command-panel.ts";

const rows = (command: string, width: number) => formatShellCommand(command, width).split("\n");

describe("formatShellCommand", () => {
	test("breaks long chains after top-level operators", () => {
		const lines = rows("cd /a/long/project/path && rm -rf /tmp/build-check && bun build src/index.ts --target=node && git diff --check", 48);

		expect(lines[0]).toBe("cd /a/long/project/path &&");
		expect(lines.some((line) => line.startsWith("rm "))).toBe(true);
		expect(lines.some((line) => line.startsWith("bun "))).toBe(true);
		expect(lines.at(-1)).toBe("git diff --check");
		expect(lines.every((line) => line.length <= 48)).toBe(true);
	});

	test("keeps quotes, substitutions and case terminators whole", () => {
		const lines = rows(`printf '%s\\n' "hello && quoted" "$(printf 'nested | value')" && echo done`, 68);
		expect(lines.join("\n")).toContain('"hello && quoted"');
		expect(lines.join("\n")).toContain(`"$(printf 'nested | value')"`);
		expect(lines.at(-1)).toBe("echo done");
		expect(rows("case $x in a) echo first-branch-value ;; b) echo second ;; esac", 40).join(" ")).toContain(";;");
	});

	test("wraps long words with a continuation indent and joins stranded operators", () => {
		expect(rows("  src/renderer.test.ts && echo done", 24)).toEqual(["  src/renderer.test.ts", "    && echo done"]);
		expect(rows("bun test alpha.test.ts beta.test.ts gamma.test.ts", 24)).toEqual(["bun test alpha.test.ts", "  beta.test.ts", "  gamma.test.ts"]);
	});

	test("leaves short lines, heredoc bodies and comments' operators alone", () => {
		const loop = `for item in alpha beta; do\n  printf '%s\\n' "$item"\ndone`;
		expect(formatShellCommand(loop, 80)).toBe(loop);
		const heredoc = `cat <<'EOF' > notes.txt\nthis body line is long enough to wrap && must keep its layout | intact\nEOF`;
		expect(formatShellCommand(heredoc, 30)).toBe(heredoc);
		expect(rows("echo done # a comment with && and | inside it", 24)).toEqual(["echo done # a comment", "  with && and | inside", "  it"]);
	});
});
