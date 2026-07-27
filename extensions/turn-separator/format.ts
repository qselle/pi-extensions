/** Pure formatting for the turn separator (no pi/tui imports; unit-testable). */

import { statsLabel, type TurnStats } from "./stats.ts";

// Duration formatting lives in stats.ts (which owns label assembly); re-exported
// here so existing importers and tests keep working.
export { formatDuration } from "./stats.ts";

/**
 * A horizontal rule, optionally labeled `── Worked for <duration> · ↓4.2K ↑318 ───…`.
 * Leaves a 1-column right margin to avoid terminal wrap artifacts. Falls back to
 * a bare rule for sub-second work with no stats, or when no label fits.
 */
export function separatorText(
	seconds: number | undefined,
	width: number,
	stats?: TurnStats,
): string {
	const usable = Math.max(4, width - 1);
	const lead = 2;
	// Reserve the lead, both label spaces, and at least one trailing dash.
	const budget = usable - lead - 3;
	const label = budget > 0 ? statsLabel(seconds, stats, budget) : "";
	if (!label) return "─".repeat(usable);
	const padded = ` ${label} `;
	return "─".repeat(lead) + padded + "─".repeat(Math.max(1, usable - lead - padded.length));
}
