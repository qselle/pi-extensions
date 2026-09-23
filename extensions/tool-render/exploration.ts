/** The first call renders the group; followers render empty. Grouping is live-only. */
import { labelText, searchTarget, shortPath } from "./render.ts";

export const EXPLORATION_TOOLS = new Set<string>(["read", "grep", "find", "ls"]);

export type Status = "pending" | "done" | "error";

export interface Activity {
	verb: string;
	detail: string;
	path?: string; // reads: the coalescing key
	filePath?: string; // raw path for terminal hyperlinks
	range?: string; // chunked reads: "10-40"
}

export interface DisplayRow {
	verb: string;
	detail: string;
	suffix?: string; // range or result count, rendered dim
	status: Status;
	filePath?: string;
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
	if (name === "read" && typeof a.path === "string") {
		const path = shortPath(labelText(a.path));
		return { verb: "Read", detail: path, path: a.path, filePath: a.path, range: readRange(a) };
	}
	if (name === "ls") return { verb: "Listed", detail: shortPath(labelText(a.path ?? a.dir ?? ".")), filePath: String(a.path ?? a.dir ?? ".") };
	if (name === "grep" && a.pattern != null) return { verb: "Searched", detail: searchTarget(a) };
	if (name === "find" && (a.pattern ?? a.name) != null) return { verb: "Found", detail: searchTarget(a) };
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
			rows.push({ verb: c.verb, detail: c.detail, suffix: c.count, status: c.status, filePath: c.filePath });
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
		for (const group of byPath.values()) {
			rows.push({ verb: "Read", detail: group[0]!.detail, filePath: group[0]!.filePath, suffix: readsSuffix(group), status: mergeStatus(group) });
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

export function resetExploration(): void {
	groups.clear();
	callToGroup.clear();
	currentId = undefined;
	seq = 0;
}
