/**
 * Pure editor-line transform for the Codex-style prompt. No pi/tui imports so it
 * is unit-testable in isolation.
 *
 * pi's editor renders as: a plain top `─` rule, content lines (a 2-space left
 * gutter + text, no side borders), a plain bottom `─` rule, then optional
 * autocomplete. We keep the rules (so `cat-buddy` still finds the editor) and
 * replace the first content line's 2-space gutter with the prompt ("› ").
 */

const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI, "");
}

/** A plain horizontal rule (all `─`/spaces) — not a scroll indicator like `─── ↑ 3 more ───`. */
export function isPlainRule(bare: string): boolean {
	return bare.length > 0 && /^[\s─]*$/.test(bare) && bare.includes("─");
}

/**
 * Rewrite pi's editor lines into a Codex-style prompt while keeping every line
 * (so the inherited `getCursor()` stays correct and `cat-buddy` can still find
 * the editor's `─` rules): the first content line's 2-space gutter becomes the
 * prompt ("› ").
 */
export function transformEditorLines(lines: string[], prompt: string): string[] {
	if (lines.length === 0) return [prompt];
	const out = [...lines];
	const gutter = out.findIndex((l) => l.startsWith("  "));
	const at = gutter >= 0 ? gutter : out.findIndex((l) => !isPlainRule(stripAnsi(l)) && l.trim().length > 0);
	if (at >= 0) {
		out[at] = out[at]!.startsWith("  ") ? prompt + out[at]!.slice(2) : prompt + out[at]!;
	}
	return out;
}
