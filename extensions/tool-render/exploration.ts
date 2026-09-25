/** The first call renders the group; followers render empty until expanded. */
import { firstLine, labelText, resultText, searchTarget, shortPath, summarize, type ToolName } from "./render.ts";
import { toolPurpose } from "../../lib/tool-purpose.ts";

export const EXPLORATION_TOOLS = new Set<string>(["read", "grep", "find", "ls"]);

export type Status = "pending" | "done" | "error";

export interface Activity {
	verb: string;
	detail: string;
	path?: string; // reads: the coalescing key
	filePath?: string; // raw path for terminal hyperlinks
	range?: string; // chunked reads: "10-40"
	purpose?: string;
}

export interface DisplayRow {
	verb: string;
	detail: string;
	suffix?: string; // range or result count, rendered dim
	status: Status;
	filePath?: string;
	purpose?: string;
}

interface Call extends Activity {
	id: string;
	index: number;
	status: Status;
	count?: string; // result summary, e.g. "42 lines"
}
interface Group {
	id: string;
	leaderId: string;
	calls: Call[];
	accepting: boolean;
	rerender?: () => void;
}

const groups = new Map<string, Group>();
const callToGroup = new Map<string, string>();
let currentId: string | undefined;
let seq = 0;

export function readRange(args: any): string | undefined {
	const offset = Number.isInteger(args?.offset) ? args.offset : undefined;
	const limit = Number.isInteger(args?.limit) ? args.limit : undefined;
	if (offset !== undefined && limit !== undefined) return `${offset}-${offset + limit - 1}`;
	if (offset !== undefined) return `${offset}+`;
	if (limit !== undefined) return `1-${limit}`;
	return undefined;
}

export function activityFor(name: string, args: any): Activity | undefined {
	const a = args ?? {};
	const purpose = toolPurpose(a.purpose, [a.path, a.pattern, a.query, a.name]) || undefined;
	if (name === "read" && typeof a.path === "string") {
		const path = shortPath(labelText(a.path));
		return { verb: "Read", detail: path, path: a.path, filePath: a.path, range: readRange(a), purpose };
	}
	if (name === "ls") return { verb: "Listed", detail: shortPath(labelText(a.path ?? a.dir ?? ".")), filePath: String(a.path ?? a.dir ?? "."), purpose };
	if (name === "grep" && a.pattern != null) return { verb: "Searched", detail: searchTarget(a), purpose };
	if (name === "find" && (a.pattern ?? a.name) != null) return { verb: "Found", detail: searchTarget(a), purpose };
	return undefined;
}

export function noteStart(id: string, name: string, args: any): void {
	if (callToGroup.has(id)) return;
	const act = activityFor(name, args);
	if (!act) return;
	let g = currentId ? groups.get(currentId) : undefined;
	if (!g || !g.accepting) {
		g = { id: `explore-${++seq}`, leaderId: id, calls: [], accepting: true };
		groups.set(g.id, g);
		currentId = g.id;
	}
	g.calls.push({ ...act, id, status: "pending", index: g.calls.length });
	callToGroup.set(id, g.id);
	g.rerender?.();
}

export function noteEnd(id: string, isError: boolean, count?: string): void {
	const g = groupOf(id);
	const c = g?.calls.find((x) => x.id === id);
	if (g && c) {
		c.status = isError ? "error" : "done";
		if (count) c.count = count;
		g.rerender?.();
	}
}

export function closeGroup(): void {
	if (!currentId) return;
	const g = groups.get(currentId);
	currentId = undefined;
	if (g) {
		g.accepting = false;
		g.rerender?.();
	}
}

export function groupOf(id: string | undefined): Group | undefined {
	if (!id) return undefined;
	const gid = callToGroup.get(id);
	return gid ? groups.get(gid) : undefined;
}

export function isLeader(id: string | undefined): boolean {
	return !!id && groupOf(id)?.leaderId === id;
}

/** The leader binds its redraw callback so joins/status changes refresh the block. */
export function bindLeaderRerender(id: string, fn: () => void): void {
	const g = groupOf(id);
	if (g && g.leaderId === id) g.rerender = fn;
}

function mergeStatus(calls: Call[]): Status {
	if (calls.some((c) => c.status === "error")) return "error";
	if (calls.some((c) => c.status === "pending")) return "pending";
	return "done";
}

function readsSuffix(reads: Call[]): string | undefined {
	const failure = reads.find((read) => read.status === "error");
	if (failure) return failure.count ?? "failed";
	const ranges = [...new Set(reads.map((r) => r.range).filter(Boolean) as string[])];
	if (ranges.length > 0) return `lines ${ranges.join(", ")}`;
	return reads.map((r) => r.count).find(Boolean); // whole-file read → line count
}

/** Coalesce a call list into display rows (consecutive same-path reads merge). */
export function toDisplayRows(calls: Call[]): DisplayRow[] {
	const rows: DisplayRow[] = [];
	for (let i = 0; i < calls.length; ) {
		const c = calls[i]!;
		if (c.verb !== "Read") {
			rows.push({ verb: c.verb, detail: c.detail, suffix: c.count, status: c.status, filePath: c.filePath, purpose: c.purpose });
			i += 1;
			continue;
		}
		const reads: Call[] = [];
		while (i < calls.length && calls[i]!.verb === "Read") reads.push(calls[i++]!);
		const byPath = new Map<string, Call[]>();
		for (const r of reads) {
			const key = JSON.stringify([r.path ?? r.detail, r.purpose ?? ""]);
			const list = byPath.get(key);
			if (list) list.push(r);
			else byPath.set(key, [r]);
		}
		for (const group of byPath.values()) {
			rows.push({ verb: "Read", detail: group[0]!.detail, filePath: group[0]!.filePath, purpose: group[0]!.purpose, suffix: readsSuffix(group), status: mergeStatus(group) });
		}
	}
	return rows;
}

export function groupState(id: string | undefined): { rows: DisplayRow[]; active: boolean } | undefined {
	const g = groupOf(id);
	if (!g) return undefined;
	const calls = g.calls.slice().sort((a, b) => a.index - b.index);
	return { rows: toDisplayRows(calls), active: g.accepting || calls.some((c) => c.status === "pending") };
}

/** A small collapsed viewport; failing and running steps take priority. */
export function previewRows(rows: readonly DisplayRow[], limit = 5): { rows: DisplayRow[]; omitted: number; failed: number; pending: number } {
	const count = Math.max(0, Math.floor(limit));
	const selected = new Set<number>();
	for (const status of ["error", "pending", "done"] as const) {
		for (let index = rows.length - 1; index >= 0 && selected.size < count; index--) {
			if (rows[index]!.status === status) selected.add(index);
		}
	}
	const shown: DisplayRow[] = [];
	let failed = 0;
	let pending = 0;
	rows.forEach((row, index) => {
		if (selected.has(index)) shown.push(row);
		else if (row.status === "error") failed++;
		else if (row.status === "pending") pending++;
	});
	return { rows: shown, omitted: rows.length - shown.length, failed, pending };
}

function record(value: unknown): Record<string, any> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

/**
 * Rebuild from the same compaction-aware entries Pi renders. Old sessions need
 * no markers: assistant call order defines the groups, saved results their
 * outcomes. Ambiguous/missing results and aborted messages stay standalone.
 */
export function restoreExploration(entries: readonly unknown[]): void {
	resetExploration();
	const messages = entries.map((entry) => {
		const saved = record(entry);
		return saved?.type === "message" ? record(saved.message) : undefined;
	});
	const occurrences = new Map<string, number>();
	const results = new Map<string, { message: Record<string, any>; index: number } | undefined>();
	for (const [index, message] of messages.entries()) {
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const value of message.content) {
				const call = record(value);
				if (call?.type === "toolCall" && typeof call.id === "string") occurrences.set(call.id, (occurrences.get(call.id) ?? 0) + 1);
			}
		} else if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
			// A duplicate result cannot safely identify the renderer that owns it.
			results.set(message.toolCallId, results.has(message.toolCallId) ? undefined : { message, index });
		}
	}
	for (const [index, message] of messages.entries()) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		closeGroup();
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		for (const value of message.content) {
			const call = record(value);
			if (call?.type !== "toolCall") continue;
			const saved = typeof call.id === "string" ? results.get(call.id) : undefined;
			const args = record(call.arguments);
			if (typeof call.name !== "string" || !EXPLORATION_TOOLS.has(call.name) || !args
				|| occurrences.get(call.id) !== 1 || !saved || saved.index <= index
				|| saved.message.toolName !== call.name || !activityFor(call.name, args)) {
				closeGroup();
				continue;
			}
			noteStart(call.id, call.name, args);
			const failed = saved.message.isError === true;
			const count = failed
				? `failed: ${labelText(firstLine(resultText(saved.message).text)).slice(0, 240) || "unknown error"}`
				: summarize(call.name as ToolName, saved.message, args);
			noteEnd(call.id, failed, count);
		}
		closeGroup();
	}
}

export function resetExploration(): void {
	groups.clear();
	callToGroup.clear();
	currentId = undefined;
	seq = 0;
}
