/**
 * footer — a single-line status bar in the Codex style, replacing pi's built-in
 * footer:
 *
 *   claude-opus-4-8 max · ~/private · Ready · Context 94% left · Context 6% used · 258K window · 28.2K used · 96K in · 521 out
 *
 * Order matches Codex: model+effort, directory, Ready/Working status, then the
 * context breakdown, then cost. Fields drop from the tail (cost first) on narrow
 * terminals; model and "% left" survive longest.
 *
 * Event-driven only: renders on the TUI's normal cycle plus agent start/settle
 * (so Ready/Working flips promptly). No timer, so idle sessions cost no battery.
 * Branch totals are cached and only rescanned when usage changes, so a frame
 * never walks the session. The footer is handed back to pi on
 * `session_shutdown`, because its factory closes over the session context and
 * that context is stale after session replacement.
 *
 * The git branch and other extensions' `setStatus()` texts come from the
 * `footerData` provider pi passes to the factory — replacing the built-in footer
 * would otherwise hide both.
 * Public APIs only: setFooter, getContextUsage, getThinkingLevel, sessionManager.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import {
	buildCells,
	fitCells,
	formatCwd,
	modelLabel,
	statusLine,
	type CellId,
} from "./format.ts";
import { UsageTotalsCache } from "./usage.ts";

type FgColor = Parameters<Theme["fg"]>[0];

/** Mostly muted like Codex; the "% left" figure and status get a subtle pop. */
const CELL_COLOR: Record<CellId, FgColor> = {
	model: "text",
	dir: "muted",
	status: "accent",
	left: "success",
	used: "muted",
	window: "muted",
	usedTok: "muted",
	in: "muted",
	out: "muted",
	cost: "success",
};

/** Cumulative token/cost totals for the active branch, including tool, child, and compaction usage. */
function currentEffort(pi: ExtensionAPI): string | undefined {
	try {
		return pi.getThinkingLevel?.();
	} catch {
		return undefined;
	}
}

export default function footerExtension(pi: ExtensionAPI): void {
	let tuiRef: { requestRender: () => void } | undefined;
	const totals = new UsageTotalsCache();

	pi.on("session_start", (_event, ctx) => {
		totals.invalidate();
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			// Pi's provider watches .git, so a checkout refreshes the branch without polling.
			const stopBranchWatch = footerData?.onBranchChange?.(() => tui.requestRender());
			return {
				invalidate() {},
				dispose() {
					stopBranchWatch?.();
					if (tuiRef === tui) tuiRef = undefined;
				},
				render(width: number): string[] {
					const cells = buildCells({
						model: modelLabel(ctx.model?.id, currentEffort(pi)),
						dir: formatCwd(ctx.cwd, homedir()),
						branch: footerData?.getGitBranch?.(),
						status: ctx.isIdle() ? "Ready" : "Working",
						usage: ctx.getContextUsage(),
						totals: totals.get(() => ctx.sessionManager.getBranch()),
					});
					const kept = fitCells(cells, width, 3, visibleWidth);
					const sep = theme.fg("dim", " · ");
					const lines = [truncateToWidth(kept.map((c) => theme.fg(CELL_COLOR[c.id], c.text)).join(sep), width)];
					// Extension statuses (ctx.ui.setStatus) get their own line, like pi's own
					// footer: they are transient and must not cannibalise the Codex line.
					const statuses = statusLine(footerData?.getExtensionStatuses?.(), sep);
					if (statuses) lines.push(truncateToWidth(statuses, width, theme.fg("dim", "…")));
					return lines;
				},
			};
		});
	});

	// Recorded usage and branch rewrites are the only things that move the totals.
	const invalidateTotals = () => {
		totals.invalidate();
	};
	pi.on("message_end", invalidateTotals);
	pi.on("session_compact", invalidateTotals);
	pi.on("session_tree", invalidateTotals);

	// The factory above closes over this session's ctx. After /new, /resume,
	// /fork, or /reload that ctx is stale and rendering with it would throw, so
	// restore pi's built-in footer before the runtime is torn down.
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
		tuiRef = undefined;
		totals.invalidate();
	});

	// Flip Ready/Working promptly without a polling timer.
	const refresh = () => tuiRef?.requestRender();
	pi.on("agent_start", refresh);
	pi.on("agent_settled", refresh);
}
