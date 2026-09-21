const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI, "");
}

/** A plain horizontal rule (all `─`/spaces) — not a scroll indicator like `─── ↑ 3 more ───`. */
export function isPlainRule(bare: string): boolean {
	return bare.length > 0 && /^[\s─]*$/.test(bare) && bare.includes("─");
}

/** Replace the first content gutter; preserve line count for cursor position and editor decorators. */
export function transformEditorLines(lines: string[], prompt: string): string[] {
	if (lines.length === 0) return [prompt];
	const out = [...lines];
	const isCompanionLine = (line: string) => /[\u2800-\u28ff]/u.test(stripAnsi(line));
	const gutter = out.findIndex((line) => !isCompanionLine(line) && line.startsWith("  "));
	const at = gutter >= 0
		? gutter
		: out.findIndex((line) => !isCompanionLine(line) && !isPlainRule(stripAnsi(line)) && line.trim().length > 0);
	if (at >= 0) {
		out[at] = out[at]!.startsWith("  ") ? prompt + out[at]!.slice(2) : prompt + out[at]!;
	}
	return out;
}
