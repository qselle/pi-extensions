/**
 * Pure logic for the tool-render extension: verbs, targets, result summaries,
 * and output bounding. No pi/tui imports and no ANSI, so it is fully
 * unit-testable; the colored rail framing lives in index.ts.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type ToolName = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls";

const HOME = homedir();

/** Collapse the home prefix to ~ for readability. */
export function shortPath(p: string): string {
	if (!p) return "";
	return p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p;
}

/** First physical line of a string. */
export function firstLine(s: string): string {
	const i = s.indexOf("\n");
	return i < 0 ? s : s.slice(0, i);
}

const VERBS: Record<ToolName, string> = {
	read: "Read",
	write: "Wrote",
	edit: "Edited",
	bash: "Ran",
	grep: "Searched",
	find: "Found",
	ls: "Listed",
};

/** Reason-first headline verb, derived deterministically from the tool (no schema change). */
export function verbFor(name: ToolName): string {
	return VERBS[name];
}

/** Headline target derived from the call args. */
export function targetFor(name: ToolName, args: any): string {
	if (!args) return "";
	switch (name) {
		case "read":
		case "write":
		case "edit":
			return shortPath(String(args.path ?? ""));
		case "ls":
			return shortPath(String(args.path ?? args.dir ?? "."));
		case "grep":
		case "find":
			return String(args.pattern ?? args.query ?? args.name ?? "");
		case "bash":
			return firstLine(String(args.command ?? "")).trim();
	}
	return "";
}

export interface ResultText {
	text: string;
	hasImage: boolean;
}

/** Flatten a tool result's content into plain text, noting image parts. */
export function resultText(result: any): ResultText {
	const c = result?.content;
	if (typeof c === "string") return { text: c, hasImage: false };
	if (Array.isArray(c)) {
		let text = "";
		let hasImage = false;
		for (const part of c) {
			if (part?.type === "text") text += (text ? "\n" : "") + String(part.text ?? "");
			else if (part?.type === "image") hasImage = true;
		}
		return { text, hasImage };
	}
	return { text: "", hasImage: false };
}

export function countNonEmptyLines(s: string): number {
	if (!s) return 0;
	return s.split("\n").filter((l) => l.trim().length > 0).length;
}

/** Count +added / -removed lines from a unified patch. */
export function diffStat(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const l of (patch ?? "").split("\n")) {
		if (l.startsWith("+") && !l.startsWith("+++")) added += 1;
		else if (l.startsWith("-") && !l.startsWith("---")) removed += 1;
	}
	return { added, removed };
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** A compact, plain one-line result summary per tool (bash renders its own body). */
export function summarize(name: ToolName, result: any, args: any): string {
	const { text, hasImage } = resultText(result);
	switch (name) {
		case "read":
			return hasImage ? "image" : plural(countNonEmptyLines(text), "line");
		case "ls":
			return plural(countNonEmptyLines(text), "entry").replace("entrys", "entries");
		case "grep":
			return plural(countNonEmptyLines(text), "match").replace("matchs", "matches");
		case "find":
			return plural(countNonEmptyLines(text), "result");
		case "write": {
			const content = typeof args?.content === "string" ? args.content : "";
			return content ? plural(content.split("\n").length, "line") : "written";
		}
		case "edit": {
			const { added, removed } = diffStat(result?.details?.patch ?? "");
			return `+${added} -${removed}`;
		}
		case "bash":
			return "";
	}
	return "";
}

/** Keep the last `maxLines` lines (command output's tail is the useful part). */
export function boundTail(text: string, maxLines: number): { lines: string[]; omitted: number } {
	const all = text.replace(/\s+$/, "").split("\n");
	if (maxLines <= 0 || all.length <= maxLines) return { lines: all, omitted: 0 };
	return { lines: all.slice(all.length - maxLines), omitted: all.length - maxLines };
}

/** Resolve a (possibly relative) tool path against the session cwd. */
export function toAbs(p: string, cwd: string): string {
	return p && isAbsolute(p) ? p : resolve(cwd || ".", p || ".");
}

/** file:// URI for an absolute path (percent-encoded, POSIX slashes). */
export function fileUri(absPath: string): string {
	return `file://${encodeURI(absPath.replace(/\\/g, "/"))}`;
}

/**
 * Wrap display text in an OSC 8 hyperlink to a file. The closing terminator is
 * always emitted, and callers pre-fit the visible text, so a truncated path
 * can never leave a dangling link. Terminals without OSC 8 ignore it.
 */
export function fileLink(display: string, absPath: string): string {
	return `\x1b]8;;${fileUri(absPath)}\x1b\\${display}\x1b]8;;\x1b\\`;
}
