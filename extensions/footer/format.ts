import { PlainOutput } from "../../lib/output.ts";

export interface ContextUsageLike {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost: number;
	/** Number of attributable model-usage records, including nested calls and warming. */
	responses?: number;
	/** Records with an absent or invalid value; omitted metadata means complete. */
	missing?: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "cost", number>>;
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

/** Semantic pressure from used context; unknown usage should never look healthy. */
export function contextColor(percent: number | null | undefined): "muted" | "success" | "warning" | "error" {
	if (percent == null || !Number.isFinite(percent)) return "muted";
	return percent >= 90 ? "error" : percent >= 75 ? "warning" : "success";
}

/** "$0.21"; sub-cent costs keep 3 decimals so they aren't flattened to $0.00. */
export function formatCost(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "$0.00";
	return n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

export function displayModelId(id: string | undefined): string {
	return id?.trim() || "no-model";
}

/** Omit the reasoning label when effort is off. */
export function modelLabel(id: string | undefined, effort: string | undefined): string {
	const name = displayModelId(id);
	return effort && effort !== "off" ? `${name} ${effort}` : name;
}

export function formatCwd(cwd: string, home: string | undefined): string {
	if (!cwd) return "";
	if (home && (cwd === home || cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`))) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
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

/** Plain, bounded text suitable for a one-line session label or footer badge. */
export function compactInlineText(value: unknown, maxCharacters: number): string {
	if (typeof value !== "string" || maxCharacters <= 0) return "";
	const normalized = new PlainOutput().push(value).replace(/\s+/g, " ").trim();
	const characters = [...normalized];
	return characters.length <= maxCharacters
		? normalized
		: `${characters.slice(0, Math.max(0, maxCharacters - 1)).join("")}…`;
}
