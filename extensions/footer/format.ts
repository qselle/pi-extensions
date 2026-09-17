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
	| "session"
	| "model"
	| "badges"
	| "status"
	| "context"
	| "contextTokens"
	| "traffic"
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
	if (home && (cwd === home || cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`))) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

export interface FooterInput {
	/** User-facing session name. Omitted until the session has been named. */
	session?: string;
	/** Pre-composed model + effort label, e.g. "claude-opus-4-8 max". */
	model: string;
	/** Short first-line contributions from optional extensions. */
	badges?: readonly string[];
	status: "ready" | "working";
	usage: ContextUsageLike | undefined;
	totals: UsageTotals;
}

/**
 * Build the left-hand information cells. The workspace is laid out separately
 * so it can remain anchored to the right instead of drifting with token totals.
 */
export function buildCells(input: FooterInput): Cell[] {
	const { session, model, badges = [], status, usage, totals } = input;
	const usedPercent = usage?.percent ?? null;
	const leftPercent = usedPercent == null ? null : Math.max(0, 100 - usedPercent);
	const contextTokens = usage
		? `${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)}`
		: undefined;
	const badgeText = badges.length > 0 ? badges.map((badge) => `[${badge}]`).join(" ") : undefined;
	const cells: Cell[] = [
		{ id: "session", text: session ?? "", priority: 7 },
		{ id: "model", text: model, priority: 0 },
		{ id: "badges", text: badgeText ?? "", priority: 5 },
		{ id: "status", text: `● ${status}`, priority: 4 },
		{ id: "context", text: `ctx ${formatPercent(leftPercent)} left`, priority: 0 },
		{ id: "contextTokens", text: contextTokens ?? "", priority: 8 },
		{
			id: "traffic",
			text: totals.input > 0 || totals.output > 0
				? `↓${formatTokens(totals.input)} ↑${formatTokens(totals.output)}`
				: "",
			priority: 9,
		},
	];
	if (totals.cost > 0) cells.push({ id: "cost", text: formatCost(totals.cost), priority: 6 });
	return cells.filter((cell) => cell.text.length > 0);
}

/** Right-hand workspace label. Kept separate so renderers can right-align it. */
export function workspaceLabel(dir: string, branch?: string | null): string {
	return branch ? `${dir} · ${branch}` : dir;
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

export interface FooterLayout<T extends { text: string }> {
	cells: T[];
	workspace: string;
	gap: number;
}

/**
 * Fit a left information rail and right-anchored workspace into one row.
 * Optional information is removed before the workspace, then long workspaces
 * are shortened from the start so the repository and branch remain visible.
 */
export function layoutFooter<T extends { text: string; priority: number }>(
	cells: T[],
	workspace: string,
	maxWidth: number,
	separator = " · ",
	widthOf: (s: string) => number = (s) => [...s].length,
): FooterLayout<T> {
	if (maxWidth <= 0) return { cells: [], workspace: "", gap: 0 };
	const separatorWidth = widthOf(separator);
	const minGap = 2;
	const rightLimit = Math.min(maxWidth, Math.max(16, Math.floor(maxWidth * 0.42)));
	let right = truncateWorkspaceToWidth(workspace.trim(), rightLimit, widthOf);
	const budget = Math.max(1, maxWidth - (right ? widthOf(right) + minGap : 0));
	const kept = fitCells(cells, budget, separatorWidth, widthOf);
	const leftWidth = joinedWidth(kept, separatorWidth, widthOf);

	if (right && leftWidth + minGap + widthOf(right) > maxWidth) {
		const available = maxWidth - leftWidth - minGap;
		right = available >= 8 ? truncateWorkspaceToWidth(right, available, widthOf) : "";
	}
	const rightWidth = widthOf(right);
	const gap = right ? Math.max(minGap, maxWidth - leftWidth - rightWidth) : 0;
	return { cells: kept, workspace: right, gap };
}

function joinedWidth<T extends { text: string }>(
	cells: readonly T[],
	separatorWidth: number,
	widthOf: (s: string) => number,
): number {
	return cells.reduce((sum, cell) => sum + widthOf(cell.text), 0)
		+ separatorWidth * Math.max(0, cells.length - 1);
}

function truncateWorkspaceToWidth(text: string, maxWidth: number, widthOf: (s: string) => number): string {
	if (widthOf(text) <= maxWidth) return text;
	const separator = " · ";
	const split = text.lastIndexOf(separator);
	if (split < 0) return truncateStartToWidth(text, maxWidth, widthOf);
	const directory = text.slice(0, split);
	const branch = text.slice(split + separator.length);
	const contentWidth = maxWidth - widthOf(separator);
	if (contentWidth < 8) return truncateStartToWidth(text, maxWidth, widthOf);
	const branchWidth = Math.max(5, Math.floor(contentWidth * 0.52));
	const directoryWidth = contentWidth - branchWidth;
	return `${truncateStartToWidth(directory, directoryWidth, widthOf)}${separator}${truncateEndToWidth(branch, branchWidth, widthOf)}`;
}

function truncateStartToWidth(text: string, maxWidth: number, widthOf: (s: string) => number): string {
	if (!text || maxWidth <= 0) return "";
	if (widthOf(text) <= maxWidth) return text;
	const ellipsis = "…";
	if (widthOf(ellipsis) >= maxWidth) return ellipsis;
	const characters = [...text];
	while (characters.length > 0 && widthOf(`${ellipsis}${characters.join("")}`) > maxWidth) characters.shift();
	return `${ellipsis}${characters.join("")}`;
}

function truncateEndToWidth(text: string, maxWidth: number, widthOf: (s: string) => number): string {
	if (!text || maxWidth <= 0) return "";
	if (widthOf(text) <= maxWidth) return text;
	const ellipsis = "…";
	if (widthOf(ellipsis) >= maxWidth) return ellipsis;
	const characters = [...text];
	while (characters.length > 0 && widthOf(`${characters.join("")}${ellipsis}`) > maxWidth) characters.pop();
	return `${characters.join("")}${ellipsis}`;
}

/** Plain, bounded text suitable for a one-line session label or footer badge. */
export function compactInlineText(value: unknown, maxCharacters: number): string {
	if (typeof value !== "string" || maxCharacters <= 0) return "";
	const normalized = value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = [...normalized];
	return characters.length <= maxCharacters
		? normalized
		: `${characters.slice(0, Math.max(0, maxCharacters - 1)).join("")}…`;
}

/**
 * Flatten one status text onto a single line.
 *
 * Mirrors pi's own footer sanitizer: newlines, tabs, and carriage returns become
 * spaces, runs of spaces collapse, and the result is trimmed. Styling is left
 * intact because extensions colour their own status text.
 */
export function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/**
 * The extension status line, built from `ctx.ui.setStatus()` entries.
 *
 * Sorted by key so the order is stable regardless of which extension reported
 * first, matching pi's built-in footer. Returns "" when nothing is reported, in
 * which case the caller omits the line entirely.
 */
export function statusLine(statuses: Iterable<readonly [string, string]> | undefined, separator = " · "): string {
	if (!statuses) return "";
	return [...statuses]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.filter((text) => text.length > 0)
		.join(separator);
}
