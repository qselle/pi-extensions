import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { basename } from "node:path";
import {
	buildCells,
	compactInlineText,
	contextColor,
	formatCwd,
	layoutFooter,
	modelLabel,
	statusLine,
	workspaceLabel,
	type Cell,
	type CellId,
} from "./format.ts";
import { UsageTotalsCache } from "./usage.ts";

export const FOOTER_BADGE_EVENT = "footer:badge";
export const TERMINAL_TITLE_OVERRIDE_EVENT = "terminal-title:override";

export interface FooterBadgeUpdate {
	/** Stable owner key. Emitting the same key replaces the previous badge. */
	id: string;
	/** Plain short label. Omit or empty it to remove the badge. */
	text?: string;
	/** Lower values appear first. */
	order?: number;
}

interface TerminalTitleOverride {
	source: string;
	title?: string;
}

interface StoredBadge {
	text: string;
	order: number;
}

type FgColor = Parameters<Theme["fg"]>[0];

const TITLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const TITLE_INTERVAL_MS = 160;

const CELL_COLOR: Record<CellId, FgColor> = {
	session: "accent",
	model: "text",
	badges: "warning",
	status: "accent",
	context: "success",
	contextTokens: "muted",
	traffic: "muted",
	cost: "success",
};

function currentEffort(pi: ExtensionAPI): string | undefined {
	try {
		return pi.getThinkingLevel?.();
	} catch {
		return undefined;
	}
}

function currentSessionName(pi: ExtensionAPI): string | undefined {
	try {
		return compactInlineText(pi.getSessionName?.(), 32) || undefined;
	} catch {
		return undefined;
	}
}

function baseTerminalTitle(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const project = compactInlineText(basename(ctx.cwd), 40) || "pi";
	const session = compactInlineText(pi.getSessionName?.(), 64);
	return session && session !== project ? `π ${session} · ${project}` : `π ${project}`;
}

function normalizeBadgeUpdate(value: unknown): { id: string; badge?: StoredBadge } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as FooterBadgeUpdate;
	const id = compactInlineText(input.id, 32);
	if (!id) return undefined;
	const text = compactInlineText(input.text, 18);
	if (!text) return { id };
	const order = typeof input.order === "number" && Number.isFinite(input.order)
		? Math.max(-1000, Math.min(1000, Math.trunc(input.order)))
		: 0;
	return { id, badge: { text, order } };
}

function normalizeTitleOverride(value: unknown): { source: string; title?: string } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as TerminalTitleOverride;
	const source = compactInlineText(input.source, 32);
	if (!source) return undefined;
	const title = compactInlineText(input.title, 120);
	return title ? { source, title } : { source };
}

export default function footerExtension(pi: ExtensionAPI): void {
	let tuiRef: { requestRender: () => void } | undefined;
	let activeCtx: ExtensionContext | undefined;
	let sessionOpen = false;
	let agentActive = false;
	let titleTimer: ReturnType<typeof setInterval> | undefined;
	let titleFrame = 0;
	let lastTerminalTitle: string | undefined;
	const totals = new UsageTotalsCache();
	const badges = new Map<string, StoredBadge>();
	const titleOverrides = new Map<string, string>();

	const refresh = () => tuiRef?.requestRender();

	const latestTitleOverride = (): string | undefined => [...titleOverrides.values()].at(-1);

	const syncTerminalTitle = () => {
		const ctx = activeCtx;
		if (!ctx || ctx.mode !== "tui") return;
		const override = latestTitleOverride();
		let title = override ?? baseTerminalTitle(pi, ctx);
		if (!override && agentActive) {
			title = `${TITLE_FRAMES[titleFrame % TITLE_FRAMES.length]} ${title}`;
			titleFrame += 1;
		}
		if (title === lastTerminalTitle) return;
		ctx.ui.setTitle(title);
		lastTerminalTitle = title;
	};

	const stopTitleTimer = () => {
		if (!titleTimer) return;
		clearInterval(titleTimer);
		titleTimer = undefined;
	};

	const startTitleTimer = () => {
		stopTitleTimer();
		titleFrame = 0;
		syncTerminalTitle();
		titleTimer = setInterval(syncTerminalTitle, TITLE_INTERVAL_MS);
		titleTimer.unref?.();
	};

	pi.events.on(FOOTER_BADGE_EVENT, (value) => {
		const update = normalizeBadgeUpdate(value);
		if (!update) return;
		if (update.badge) badges.set(update.id, update.badge);
		else badges.delete(update.id);
		refresh();
	});

	// Questionnaire and future attention extensions already emit this event.
	// A source-keyed stack prevents one owner from clearing another owner's title.
	pi.events.on(TERMINAL_TITLE_OVERRIDE_EVENT, (value) => {
		const update = normalizeTitleOverride(value);
		if (!update) return;
		titleOverrides.delete(update.source);
		if (update.title) titleOverrides.set(update.source, update.title);
		syncTerminalTitle();
	});

	pi.on("session_start", (_event, ctx) => {
		sessionOpen = true;
		totals.invalidate();
		if (ctx.mode !== "tui") return;
		activeCtx = ctx;
		agentActive = !ctx.isIdle();
		lastTerminalTitle = undefined;
		if (agentActive) startTitleTimer();
		else syncTerminalTitle();

		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			const stopBranchWatch = footerData?.onBranchChange?.(() => tui.requestRender());
			return {
				invalidate() {},
				dispose() {
					stopBranchWatch?.();
					if (tuiRef === tui) tuiRef = undefined;
				},
				render(width: number): string[] {
					if (width <= 0) return [];
					const usage = ctx.getContextUsage();
					const badgeLabels = [...badges.entries()]
						.sort(([leftId, left], [rightId, right]) => left.order - right.order || leftId.localeCompare(rightId))
						.map(([, badge]) => badge.text);
					const cells = buildCells({
						session: currentSessionName(pi),
						model: modelLabel(ctx.model?.id, currentEffort(pi)),
						badges: badgeLabels,
						status: ctx.isIdle() ? "ready" : "working",
						usage,
						totals: totals.get(() => ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId()),
					});
					const workspace = workspaceLabel(
						formatCwd(ctx.cwd, homedir()),
						footerData?.getGitBranch?.(),
					);
					const separator = " · ";
					const layout = layoutFooter(cells, workspace, width, separator, visibleWidth);
					const styledSeparator = theme.fg("dim", separator);
					const left = layout.cells.map((cell: Cell) => {
						const color = cell.id === "status"
							? (ctx.isIdle() ? "success" : "accent")
							: cell.id === "context" ? contextColor(usage?.percent) : CELL_COLOR[cell.id];
						return theme.fg(color, cell.text);
					}).join(styledSeparator);
					const right = layout.workspace ? theme.fg("muted", layout.workspace) : "";
					const mainLine = `${left}${right ? " ".repeat(layout.gap) : ""}${right}`;
					const lines = [truncateToWidth(mainLine, width, "")];

					const statuses = statusLine(footerData?.getExtensionStatuses?.(), styledSeparator);
					if (statuses) lines.push(truncateToWidth(statuses, width, theme.fg("dim", "…")));
					return lines;
				},
			};
		});
	});

	const invalidateTotals = () => totals.invalidate();
	pi.on("message_end", invalidateTotals);
	pi.on("session_compact", invalidateTotals);
	pi.on("session_tree", invalidateTotals);

	pi.on("session_info_changed", (_event, ctx) => {
		if (!sessionOpen || ctx.mode !== "tui") return;
		activeCtx = ctx;
		syncTerminalTitle();
		refresh();
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!sessionOpen) return;
		if (ctx.mode === "tui") {
			activeCtx = ctx;
			agentActive = true;
			startTitleTimer();
		}
		refresh();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!sessionOpen) return;
		if (ctx.mode === "tui") {
			activeCtx = ctx;
			agentActive = false;
			stopTitleTimer();
			titleFrame = 0;
			syncTerminalTitle();
		}
		refresh();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionOpen = false;
		stopTitleTimer();
		agentActive = false;
		titleFrame = 0;
		if (ctx.mode === "tui") {
			ctx.ui.setFooter(undefined);
			ctx.ui.setTitle("pi");
		}
		activeCtx = undefined;
		lastTerminalTitle = undefined;
		titleOverrides.clear();
		tuiRef = undefined;
		totals.invalidate();
	});
}
