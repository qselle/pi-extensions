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
 * Public APIs only: setFooter, getContextUsage, getThinkingLevel, sessionManager.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import {
	buildCells,
	fitCells,
	formatCwd,
	modelLabel,
	type CellId,
	type UsageTotals,
} from "./format.ts";

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

/** Cumulative token/cost totals for the active branch, including child + compaction usage. */
function sumUsage(ctx: ExtensionContext): UsageTotals {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		const usage =
			entry?.type === "message" && entry.message?.role === "assistant"
				? (entry.message as AssistantMessage).usage
				: entry?.type === "branch_summary" || entry?.type === "compaction"
					? entry.usage
					: undefined;
		if (!usage) continue;
		input += usage.input ?? 0;
		output += usage.output ?? 0;
		cost += usage.cost?.total ?? 0;
	}
	return { input, output, cost };
}

function currentEffort(pi: ExtensionAPI): string | undefined {
	try {
		return pi.getThinkingLevel?.();
	} catch {
		return undefined;
	}
}

export default function footerExtension(pi: ExtensionAPI): void {
	let tuiRef: { requestRender: () => void } | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme) => {
			tuiRef = tui;
			return {
				invalidate() {},
				render(width: number): string[] {
					const cells = buildCells({
						model: modelLabel(ctx.model?.id, currentEffort(pi)),
						dir: formatCwd(ctx.cwd, homedir()),
						status: ctx.isIdle() ? "Ready" : "Working",
						usage: ctx.getContextUsage(),
						totals: sumUsage(ctx),
					});
					const kept = fitCells(cells, width, 3, visibleWidth);
					const sep = theme.fg("dim", " · ");
					return [truncateToWidth(kept.map((c) => theme.fg(CELL_COLOR[c.id], c.text)).join(sep), width)];
				},
			};
		});
	});

	// Flip Ready/Working promptly without a polling timer.
	const refresh = () => tuiRef?.requestRender();
	pi.on("agent_start", refresh);
	pi.on("agent_settled", refresh);
}
