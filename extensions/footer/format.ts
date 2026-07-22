/**
 * Pure formatting + layout helpers for the footer.
 *
 * Deliberately free of pi/tui imports so they stay trivially unit-testable and
 * so `widthOf` can be swapped for an ANSI-aware measurer at render time.
 */

export interface ContextUsageLike {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface UsageTotals {
	input: number;
	output: number;
	cost: number;
}

export type CellId =
	| "model"
	| "dir"
	| "status"
	| "left"
	| "used"
	| "window"
	| "usedTok"
	| "in"
	| "out"
	| "cost";

export interface Cell {
	id: CellId;
	text: string;
	/** 0 = never dropped; higher = dropped earlier when the line is too wide. */
	priority: number;
}

const trimZeros = (s: string): string => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

/** Compact token count: 521 -> "521", 96000 -> "96K", 28200 -> "28.2K", 2_350_000 -> "2.35M". */
export function formatTokens(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n)) return "?";
	const abs = Math.abs(n);
	if (abs < 1000) return `${Math.round(n)}`;
	if (abs < 1_000_000) {
		const k = n / 1000;
		return `${abs >= 100_000 ? Math.round(k) : trimZeros(k.toFixed(1))}K`;
	}
	return `${trimZeros((n / 1_000_000).toFixed(2))}M`;
}

/** Whole-percent string, or "?%" when unknown (e.g. right after compaction). */
export function formatPercent(p: number | null | undefined): string {
	if (p == null || !Number.isFinite(p)) return "?%";
	return `${Math.round(p)}%`;
}

/** "$0.21"; sub-cent costs keep 3 decimals so they aren't flattened to $0.00. */
export function formatCost(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "$0.00";
	return n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

/**
 * Display a model id with its effort. The id is shown as-is (routing prefix and
 * provider kept), e.g. "global.anthropic.claude-opus-4-8".
 */
export function displayModelId(id: string | undefined): string {
	return id?.trim() || "no-model";
}

/** Model plus reasoning effort, Codex-style: "global.anthropic.claude-opus-4-8 max". Effort "off" is omitted. */
export function modelLabel(id: string | undefined, effort: string | undefined): string {
	const name = displayModelId(id);
	return effort && effort !== "off" ? `${name} ${effort}` : name;
}

/** Collapse the home prefix to ~ for readability. */
export function formatCwd(cwd: string, home: string | undefined): string {
	if (!cwd) return "";
	if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
	return cwd;
}

export interface FooterInput {
	/** Pre-composed model + effort label, e.g. "claude-opus-4-8 max". */
	model: string;
	dir: string;
	status: string;
	usage: ContextUsageLike | undefined;
	totals: UsageTotals;
}

/**
 * The single Codex-style footer line, in display order:
 *   model effort · dir · status · Context X% left · Context Y% used · W window · U used · I in · O out · $cost
 * Drop priority increases toward the tail so model + "% left" survive longest.
 */
export function buildCells(input: FooterInput): Cell[] {
	const { model, dir, status, usage, totals } = input;
	const usedPercent = usage?.percent ?? null;
	const leftPercent = usedPercent == null ? null : Math.max(0, 100 - usedPercent);
	const cells: Cell[] = [
		{ id: "model", text: model, priority: 0 },
		{ id: "dir", text: dir, priority: 4 },
		{ id: "status", text: status, priority: 3 },
		{ id: "left", text: `Context ${formatPercent(leftPercent)} left`, priority: 1 },
		{ id: "used", text: `Context ${formatPercent(usedPercent)} used`, priority: 2 },
		{ id: "window", text: `${formatTokens(usage?.contextWindow ?? 0)} window`, priority: 5 },
		{ id: "usedTok", text: `${formatTokens(usage?.tokens ?? null)} used`, priority: 6 },
		{ id: "in", text: `${formatTokens(totals.input)} in`, priority: 7 },
		{ id: "out", text: `${formatTokens(totals.output)} out`, priority: 8 },
	];
	if (totals.cost > 0) cells.push({ id: "cost", text: formatCost(totals.cost), priority: 9 });
	return cells.filter((c) => c.text.length > 0);
}

/**
 * Drop the highest-priority cells (ties: rightmost) until the joined line fits.
 * `widthOf` defaults to code-point count; render passes an ANSI-aware measurer.
 */
export function fitCells<T extends { text: string; priority: number }>(
	cells: T[],
	maxWidth: number,
	sepWidth = 3,
	widthOf: (s: string) => number = (s) => [...s].length,
): T[] {
	const kept = [...cells];
	const total = () =>
		kept.reduce((sum, c) => sum + widthOf(c.text), 0) + sepWidth * Math.max(0, kept.length - 1);
	while (kept.length > 1 && total() > maxWidth) {
		let idx = -1;
		let worst = 0;
		for (let i = 0; i < kept.length; i++) {
			const p = kept[i]!.priority;
			if (p > 0 && p >= worst) {
				worst = p;
				idx = i;
			}
		}
		if (idx < 0) break;
		kept.splice(idx, 1);
	}
	return kept;
}
