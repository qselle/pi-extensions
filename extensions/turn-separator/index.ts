/**
 * turn-separator — a dim rule between assistant messages that follow tool work,
 * labeled "Worked for <duration>" in the Codex style.
 *
 * When a new assistant message starts and at least one tool ran since the
 * previous assistant message, a custom (non-LLM) entry is appended and rendered
 * as a dim, width-aware rule. Purely event-driven (no timer), so an idle session
 * does no rendering work. Uses public APIs only: appendEntry + registerEntryRenderer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { separatorText } from "./format.ts";

const ENTRY_TYPE = "worked-for-separator";

export default function turnSeparatorExtension(pi: ExtensionAPI): void {
	// Timestamp of the first tool run since the last assistant message, if any.
	// Reset when a separator is emitted (below), not on turn_start — turn_start
	// re-fires per model round-trip and would wipe it before the post-tool message.
	let workStart: number | undefined;

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const seconds = (entry?.data as { seconds?: number } | undefined)?.seconds;
		return {
			invalidate() {},
			render(width: number): string[] {
				return [theme.fg("dim", separatorText(seconds, Math.max(1, width)))];
			},
		};
	});

	pi.on("tool_execution_start", () => {
		if (workStart == null) workStart = Date.now();
	});

	pi.on("message_start", (event) => {
		if ((event as any)?.message?.role !== "assistant") return;
		if (workStart == null) return;
		const seconds = Math.round((Date.now() - workStart) / 1000);
		workStart = undefined;
		pi.appendEntry(ENTRY_TYPE, { seconds });
	});
}
