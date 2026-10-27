import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { expansionHint } from "../../lib/tool-ui.ts";
import { highlightSyntax } from "../../lib/syntax.ts";
import { boundTail, resultText } from "./render.ts";
import { fit } from "./lines.ts";
import { formatElapsed, type BashOutcome } from "./bash-status.ts";

export const BULLET = "•";
const BRANCH = "└";

export function branchBody(theme: Theme, contentLines: string[], width: number): string[] {
	const inner = Math.max(1, width - 4);
	const first = `${theme.fg("dim", `  ${BRANCH} `)}`;
	const rest = "    ";
	return contentLines.map((line, i) => (i === 0 ? first : rest) + fit(line, inner));
}

/** Keep other themes, unsupported grammars and startup fallback native. */
export function highlightPreview(code: string, language: string, theme: Theme): string[] | undefined {
	try {
		return (theme.name === "gruvbox-dark" ? highlightSyntax(code, language) : undefined)
			?? highlightCode(code, language);
	} catch {
		return undefined;
	}
}

/** Highlight before wrapping so strings and heredocs retain their context. */
export function highlightSource(source: string, language: string, theme: Theme): string {
	let colored = source;
	// Bound parser work for unusually large calls. The managed tool already
	// limits commands to this size; longer sources keep a plain preview.
	if (source.length <= 16_000) {
		try { colored = highlightPreview(source, language, theme)?.join("\n") ?? source; }
		catch { /* A highlighting failure must not hide the source. */ }
	}
	// Restore the base foreground after highlighted tokens, without painting over
	// their colors or allowing a token color to leak into the following output.
	const base = theme.getFgAnsi?.("text") ?? "\x1b[39m";
	return theme.fg("text", colored.replace(/\x1b\[39m/g, base));
}

/** Below this width, wrapping multiplies rows without making text readable. */
const MIN_WRAP_WIDTH = 12;

export function wrapRows(text: string, width: number, always = false): string[] {
	return always || width >= MIN_WRAP_WIDTH ? wrapTextWithAnsi(text, Math.max(1, width)) : [text];
}

export function bashBody(result: any, opts: any, theme: Theme, width: number, isError = false, language?: string): string[] {
	const { text } = resultText(result);
	if (text.trim().length === 0) return isError ? branchBody(theme, [theme.fg("error", "failed")], width) : [];
	const managed = result?.details?.managed === true;
	const boundary = managed ? text.indexOf("\n\n") : -1;
	let header = boundary >= 0 ? text.slice(0, boundary).split("\n") : [];
	const output = boundary >= 0 ? text.slice(boundary + 2) : text;
	if (managed && !opts?.expanded) {
		const details = result.details;
		const quietSuccess = !isError && details.status === "completed" && details.exitCode === 0 && !details.signal
			&& !details.more && !details.lost && header.length === 2;
		if (quietSuccess) {
			header = []; // status and elapsed time are on the headline
		} else {
			// The job ID remains actionable; output cursors and the model's
			// job_wait/job_stop hint are only useful expanded.
			header = header.filter((line) => !line.startsWith("Still running — "))
				.map((line) => line.replace(/^(Job: \S+) · cursor: \d+/, "$1"));
		}
	}
	const { lines, omitted } = boundTail(output, opts?.expanded ? 200 : 8);
	const failed = isError || ["failed", "timed-out", "interrupted"].includes(result?.details?.status);
	const body: string[] = header.map((line) => theme.fg(failed ? "error" : "muted", line));
	if (omitted > 0) body.push(theme.fg("dim", `… +${omitted} lines · ${opts?.expanded ? "preview limit" : expansionHint()}`));
	const highlighted = !isError && language ? highlightPreview(lines.join("\n"), language, theme) : undefined;
	// Errors and expanded output wrap; collapsed previews keep one row per line.
	const wrap = isError || opts?.expanded;
	for (const [index, l] of lines.entries()) {
		const colored = highlighted?.[index] ?? theme.fg(isError ? "error" : "toolOutput", l);
		body.push(...(wrap ? wrapRows(colored, width - 4, isError) : [colored]));
	}
	return branchBody(theme, body, width);
}

/** Start and end times of live shell and script calls; saved results carry their own duration. */
const bashTimes = new Map<string, { start: number; end?: number }>();
const MAX_BASH_TIMES = 256;

export function noteBashTime(id: unknown, phase: "start" | "end"): void {
	if (typeof id !== "string") return;
	if (phase === "end") {
		const entry = bashTimes.get(id);
		if (entry) entry.end = Date.now();
		return;
	}
	if (bashTimes.size >= MAX_BASH_TIMES) bashTimes.delete(bashTimes.keys().next().value!);
	bashTimes.set(id, { start: Date.now() });
}

export const clearBashTimes = (): void => bashTimes.clear();

/**
 * `✓ in 3s`, `✗ exit 2 in 3s` or a live `3s` while running. Running cards are
 * rebuilt on every frame Pi paints, so no timer of our own drives the clock.
 */
export function bashStatus(theme: Theme, outcome: BashOutcome | undefined, running: boolean, id: string | undefined): string {
	const times = id ? bashTimes.get(id) : undefined;
	if (running) {
		const start = times?.start ?? outcome?.startedAt;
		const elapsed = start !== undefined ? formatElapsed(Date.now() - start) : "";
		return elapsed ? theme.fg("dim", ` · ${elapsed}`) : "";
	}
	if (!outcome) return "";
	if (outcome.state === "running") return theme.fg("dim", " · ") + theme.fg("accent", "running");
	const elapsed = outcome.elapsed ?? (times?.end !== undefined ? formatElapsed(times.end - times.start) : "");
	const mark = outcome.state === "ok" ? theme.fg("success", "✓")
		: theme.fg("error", outcome.reason ? `✗ ${outcome.reason}` : "✗");
	return theme.fg("dim", " · ") + mark + (elapsed ? theme.fg("dim", ` in ${elapsed}`) : "");
}
