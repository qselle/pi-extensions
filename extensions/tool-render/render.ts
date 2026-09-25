import { homedir } from "node:os";
import { fileUri as sharedFileUri, link as osc8Link, toAbsolutePath } from "../../lib/links.ts";
import { PlainOutput } from "../../lib/output.ts";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type ToolName = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls";

const HOME = homedir();

export function shortPath(p: string): string {
	if (!p) return "";
	return p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p;
}

/** Keep the identifying filename and extension when a path must fit one row. */
export function compactPath(path: string, width: number): string {
	const value = labelText(shortPath(path));
	const budget = Math.max(0, Math.floor(width));
	if (visibleWidth(value) <= budget) return value;
	if (budget < 2) return budget ? "…" : "";
	const split = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
	const name = value.slice(split + 1);
	const nameWidth = visibleWidth(name);
	if (split >= 0 && nameWidth + 2 <= budget) {
		return `${truncateToWidth(value.slice(0, split), budget - nameWidth - 2, "")}…${value[split]}${name}`;
	}
	const head = Math.ceil((budget - 1) / 2);
	const tail = budget - head - 1;
	const subject = name || value;
	return truncateToWidth(subject, head, "") + "…" + sliceByColumn(subject, Math.max(0, visibleWidth(subject) - tail), tail, true);
}

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

export function verbFor(name: ToolName): string {
	return VERBS[name];
}

/** Labels are single-line plain text; tool output itself remains untouched. */
export function labelText(value: unknown): string {
	return new PlainOutput().push(String(value ?? "")).replace(/\s+/g, " ").trim();
}

export function searchTarget(args: any): string {
	const query = labelText(args?.pattern ?? args?.query ?? args?.name);
	const path = args?.path == null ? "" : shortPath(labelText(args.path));
	const glob = labelText(args?.glob);
	return [`"${query}"`, path && path !== "." ? `in ${path}` : "", glob ? `(${glob})` : ""].filter(Boolean).join(" ");
}

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

export function diffStat(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const l of (patch ?? "").split("\n")) {
		if (l.startsWith("+") && !l.startsWith("+++")) added += 1;
		else if (l.startsWith("-") && !l.startsWith("---")) removed += 1;
	}
	return { added, removed };
}

const plural = (n: number, unit: string) => `${n} ${n === 1 ? unit : unit === "entry" ? "entries" : unit === "match" ? "matches" : `${unit}s`}`;

/** Only remove Pi's appended continuation notice, never arbitrary bracketed output. */
function withoutNotice(text: string, name: ToolName): string {
	const notice = name === "read"
		? /\n\n\[(?:Showing lines \d+-\d+ of \d+[^\n]*|\d+ more lines in file\. Use offset=\d+ to continue\.)\]$/
		: /\n\n\[(?:\d+ (?:matches|entries|results) limit reached[^\n]*|[\d.]+[KMGT]?B limit reached[^\n]*|Some lines truncated to \d+ chars[^\n]*)\]$/;
	return text.replace(notice, "");
}

function limitedSuffix(details: any): string {
	return details?.truncation?.truncated || details?.matchLimitReached || details?.entryLimitReached || details?.resultLimitReached
		? " · limited" : "";
}

export function summarize(name: ToolName, result: any, args: any): string {
	const { text, hasImage } = resultText(result);
	const details = result?.details;
	const body = withoutNotice(text, name);
	switch (name) {
		case "read": {
			if (hasImage) return "image";
			const count = Number.isSafeInteger(details?.truncation?.outputLines) ? details.truncation.outputLines : body ? body.split("\n").length : 0;
			return plural(count, "line") + limitedSuffix(details);
		}
		case "ls":
			return plural(text.trim() === "(empty directory)" ? 0 : countNonEmptyLines(body), "entry") + limitedSuffix(details);
		case "grep": {
			if (text.trim() === "No matches found") return "0 matches";
			// Native grep marks matches path:line: and context path-line-. Count
			// matching lines, not context or the trailing truncation instructions.
			const matches = body.split("\n").map((line) => line.match(/^(.+?):\d+: /)).filter((match) => match !== null);
			const nativeFormat = matches.length > 0 || body.split("\n").some((line) => /^.+-\d+- /.test(line));
			const count = nativeFormat ? matches.length : countNonEmptyLines(body);
			const files = new Set(matches.map((match) => match[1])).size;
			return plural(count, "match") + (files ? ` · ${plural(files, "file")}` : "") + limitedSuffix(details);
		}
		case "find":
			return plural(text.trim() === "No files found matching pattern" ? 0 : countNonEmptyLines(body), "result") + limitedSuffix(details);
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

export function boundTail(text: string, maxLines: number): { lines: string[]; omitted: number } {
	const all = text.replace(/\s+$/, "").split("\n");
	if (maxLines <= 0 || all.length <= maxLines) return { lines: all, omitted: 0 };
	return { lines: all.slice(all.length - maxLines), omitted: all.length - maxLines };
}

export function toAbs(p: string, cwd: string): string {
	return toAbsolutePath(p || ".", cwd || ".");
}

export { fileUri } from "../../lib/links.ts";

export function fileLink(display: string, absPath: string): string {
	return osc8Link(display, sharedFileUri(absPath));
}
