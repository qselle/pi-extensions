/**
 * Groups consecutive exploration tool calls (read/grep/find/ls) into one
 * Codex-style "Explored" block. A global registry tracks a run of calls: the
 * first call is the leader (renders the whole block) and the rest render empty
 * (a self-shell tool that renders nothing is dropped by pi, spacer included). A
 * run closes on any non-exploration tool or a new assistant message.
 *
 * Pure registry logic (no pi/tui imports) so it's unit-testable; the theme-aware
 * block rendering lives in index.ts.
 *
 * Live only: on reload the runtime registry is empty, so each call falls back to
 * a standalone block (grouping isn't reconstructed from the session).
 */
import { shortPath } from "./render.ts";

export const EXPLORATION_TOOLS = new Set<string>(["read", "grep", "find", "ls"]);

export type Status = "pending" | "done" | "error";
export interface Activity {
	verb: string;
	detail: string;
	status: Status;
}

interface Call extends Activity {
	id: string;
	index: number;
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

/** Verb + detail for an exploration tool call, or undefined if it isn't one. */
export function activityFor(name: string, args: any): { verb: string; detail: string } | undefined {
	const a = args ?? {};
	if (name === "read" && typeof a.path === "string") return { verb: "Read", detail: shortPath(a.path) };
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
	g.calls.push({ id, verb: act.verb, detail: act.detail, status: "pending", index: g.calls.length });
	callToGroup.set(id, g.id);
	g.rerender?.();
}

export function noteEnd(id: string, isError: boolean): void {
	const g = groupOf(id);
	const c = g?.calls.find((x) => x.id === id);
	if (g && c) {
		c.status = isError ? "error" : "done";
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

export function groupState(id: string | undefined): { activities: Activity[]; active: boolean } | undefined {
	const g = groupOf(id);
	if (!g) return undefined;
	const activities = g.calls
		.slice()
		.sort((a, b) => a.index - b.index)
		.map((c) => ({ verb: c.verb, detail: c.detail, status: c.status }));
	return { activities, active: g.accepting || activities.some((a) => a.status === "pending") };
}

/** Clear all state (call on a new session). */
export function resetExploration(): void {
	groups.clear();
	callToGroup.clear();
	currentId = undefined;
	seq = 0;
}
