import { statsLabel, type StatStyle, type TurnStats } from "./stats.ts";

export { formatDuration } from "./stats.ts";

/**
 * A horizontal rule, optionally labeled `── Worked for <duration> · in 4.2K · out 318 ───…`.
 * Leaves a 1-column right margin to avoid terminal wrap artifacts. Falls back to
 * a bare rule when the duration is unknown or no label fits.
 */
export function separatorText(
	seconds: number | undefined,
	width: number,
	stats?: TurnStats,
	style: StatStyle = (_color, text) => text,
	widthOf: (value: string) => number = (value) => [...value].length,
): string {
	if (!Number.isFinite(width) || width < 1) return "";
	const columns = Math.floor(width);
	const usable = columns === 1 ? 1 : columns - 1;
	const lead = 2;
	// Reserve the lead, both label spaces, and at least one trailing dash.
	const budget = usable - lead - 3;
	const label = budget > 0 ? statsLabel(seconds, stats, budget, widthOf, style) : "";
	if (!label) return style("dim", "─".repeat(usable));
	const padded = ` ${label} `;
	return style("dim", "─".repeat(lead)) + padded + style("dim", "─".repeat(Math.max(1, usable - lead - widthOf(padded))));
}
