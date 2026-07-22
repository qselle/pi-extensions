/** Pure formatting for the turn separator (no pi/tui imports; unit-testable). */

export function formatDuration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
	const h = Math.floor(m / 60);
	const mm = m % 60;
	return mm ? `${h}h ${mm}m` : `${h}h`;
}

/**
 * A horizontal rule, optionally labeled `── Worked for <duration> ───…`.
 * Leaves a 1-column right margin to avoid terminal wrap artifacts. Falls back to
 * a bare rule for sub-second work or when the label can't fit.
 */
export function separatorText(seconds: number | undefined, width: number): string {
	const usable = Math.max(4, width - 1);
	if (seconds == null || seconds < 1) return "─".repeat(usable);
	const label = ` Worked for ${formatDuration(seconds)} `;
	const lead = 2;
	if (lead + label.length + 1 > usable) return "─".repeat(usable);
	return "─".repeat(lead) + label + "─".repeat(usable - lead - label.length);
}
