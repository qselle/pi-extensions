import { homedir } from "node:os";
import { fileUri as sharedFileUri, link as osc8Link, toAbsolutePath } from "../../lib/links.ts";

export type ToolName = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls";

const HOME = homedir();

export function shortPath(p: string): string {
	if (!p) return "";
	return p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p;
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

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

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
