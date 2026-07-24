/**
 * Groups consecutive exploration tool calls (read/grep/find/ls) into one
 * Codex-style "Explored" block. A global registry tracks a run of calls: the
 * first call is the leader (renders the whole block) and the rest render empty
 * (a self-shell tool that renders nothing is dropped by pi, spacer included). A
 * run closes on any non-exploration tool or a new assistant message.
 *
 * Display detail (pure, so it stays unit-testable):
 *   - reads show a line range (`foo.ts · lines 10-40`) when the call is chunked,
 *     otherwise a line count (`foo.ts · 42 lines`) once the result lands;
 *   - grep/find/ls show a result count (`"verify(" · 7 matches`);
 *   - consecutive reads of the same file coalesce into one row, merging ranges
 *     (`foo.ts · lines 1-40, 101-200`).
 *
 * Live only: on reload the runtime registry is empty, so each call falls back to
 * a standalone block (grouping isn't reconstructed from the session).
 */
import { shortPath } from "./render.ts";

export const EXPLORATION_TOOLS = new Set<string>(["read", "grep", "find", "ls"]);

export type Status = "pending" | "done" | "error";

/** One derived detail from a call's args (no result yet). */
export interface Activity {
	verb: string;
	detail: string;
	path?: string; // reads: the coalescing key
	range?: string; // chunked reads: "10-40"
}

/** A fully-formatted row ready to render (verb + detail + optional dim suffix). */
export interface DisplayRow {
	verb: string;
	detail: string;
	suffix?: string; // range or result count, rendered dim
	status: Status;
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

/** Range label for a chunked read, e.g. "10-40" (offset+limit), or undefined. */
export function readRange(args: any): string | undefined {
	const offset = Number.isInteger(args?.offset) ? args.offset : undefined;
	const limit = Number.isInteger(args?.limit) ? args.limit : undefined;
	if (offset !== undefined && limit !== undefined) return `${offset}-${offset + limit - 1}`;
	if (offset !== undefined) return `${offset}+`;
	if (limit !== undefined) return `1-${limit}`;
	return undefined;
}

/** Verb + detail for an exploration tool call, or undefined if it isn't one. */
export function activityFor(name: string, args: any): Activity | undefined {
	const a = args ?? {};
	if (name === "read" && typeof a.path === "string") {
		const path = shortPath(a.path);
		return { verb: "Read", detail: path, path, range: readRange(a) };
	}
	if (name === "ls") return { verb: "Listed", detail: shortPath(String(a.path ?? a.dir ?? ".")) };
	if (name === "grep" && a.pattern != null) return { verb: "Searched", detail: `"${a.pattern}"` };
	if (name === "find" && (a.pattern ?? a.name) != null) return { verb: "Found", detail: `"${a.pattern ?? a.name}"` };
	return undefined;
}

/** Register a starting exploration call, joining the current run or opening one. */
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

/** Mark a call finished, recording its result summary (e.g. "42 lines"). */
export function noteEnd(id: string, isError: boolean, count?: string): void {
	const g = groupOf(id);
	const c = g?.calls.find((x) => x.id === id);
	if (g && c) {
		c.status = isError ? "error" : "done";
		if (count) c.count = count;
		g.rerender?.();
	}
}

/** Close the current run so later exploration calls start a fresh block. */
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

/** Suffix for a non-read call: its result count, if known. */
function readsSuffix(reads: Call[]): string | undefined {
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
			rows.push({ verb: c.verb, detail: c.detail, suffix: c.count, status: c.status });
			i += 1;
			continue;
		}
		const reads: Call[] = [];
		while (i < calls.length && calls[i]!.verb === "Read") reads.push(calls[i++]!);
		const byPath = new Map<string, Call[]>();
		for (const r of reads) {
			const key = r.path ?? r.detail;
			const list = byPath.get(key);
			if (list) list.push(r);
			else byPath.set(key, [r]);
		}
		for (const [path, group] of byPath) {
			rows.push({ verb: "Read", detail: path, suffix: readsSuffix(group), status: mergeStatus(group) });
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

/** Clear all state (call on a new session). */
export function resetExploration(): void {
	groups.clear();
	callToGroup.clear();
	currentId = undefined;
	seq = 0;
}
