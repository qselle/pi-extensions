/**
 * turn-separator — a dim rule between assistant messages that follow tool work,
 * labeled "Worked for <duration>" in the Codex style, followed by that block's
 * token, cache, throughput, and cost stats.
 *
 * When a new assistant message starts and at least one tool ran since the
 * previous assistant message, a custom (non-LLM) entry is appended and rendered
 * as a dim, width-aware rule. Stats come from real provider usage on each
 * finalized response, never estimates. Purely event-driven (no timer), so an idle
 * session does no rendering work. Uses public APIs only: appendEntry +
 * registerEntryRenderer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { separatorText } from "./format.ts";
import { addUsage, emptyStats, hasStats, tokensPerSecond, type TurnStats } from "./stats.ts";

const ENTRY_TYPE = "worked-for-separator";

interface SeparatorEntry {
	seconds?: number;
	stats?: TurnStats;
}

export default function turnSeparatorExtension(pi: ExtensionAPI): void {
	// Timestamp of the first tool run since the last assistant message, if any.
	// Reset when a separator is emitted (below), not on turn_start — turn_start
	// re-fires per model round-trip and would wipe it before the post-tool message.
	let workStart: number | undefined;
	// Usage accumulated across every response in the current work block.
	let stats: TurnStats = emptyStats();
	// Per-response timing, used for ttft and tps of the latest response.
	let requestSentAt: number | undefined;
	let firstTokenAt: number | undefined;

	const reset = () => {
		workStart = undefined;
		stats = emptyStats();
		requestSentAt = undefined;
		firstTokenAt = undefined;
	};

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry?.data as SeparatorEntry | undefined;
		return {
			invalidate() {},
			render(width: number): string[] {
				return [theme.fg("dim", separatorText(data?.seconds, Math.max(1, width), data?.stats))];
			},
		};
	});

	pi.on("session_start", () => reset());
	pi.on("session_tree", () => reset());

	// The request-send moment. message_start fires when the first chunk arrives, so
	// anchoring ttft there measures ~0 and is meaningless.
	pi.on("before_provider_request", () => {
		requestSentAt = Date.now();
		firstTokenAt = undefined;
	});

	pi.on("tool_execution_start", () => {
		if (workStart == null) workStart = Date.now();
	});

	pi.on("message_start", (event) => {
		if ((event as any)?.message?.role !== "assistant") return;
		if (workStart != null) {
			const seconds = Math.round((Date.now() - workStart) / 1000);
			const data: SeparatorEntry = { seconds, stats: hasStats(stats) ? stats : undefined };
			workStart = undefined;
			stats = emptyStats();
			pi.appendEntry(ENTRY_TYPE, data);
		}
	});

	pi.on("message_update", (event) => {
		if (firstTokenAt != null) return;
		const type = (event as any)?.assistantMessageEvent?.type;
		if (type === "text_delta" || type === "thinking_delta") firstTokenAt = Date.now();
	});

	pi.on("message_end", (event) => {
		const message = (event as any)?.message;
		if (message?.role !== "assistant") return;
		const endedAt = Date.now();
		stats = addUsage(stats, message.usage);
		// ttft/tps describe the latest response; averaging them across a block
		// would be meaningless, so the newest value wins. With no send anchor the
		// latency is unknown, which is reported by omitting it rather than as 0ms.
		if (requestSentAt != null && firstTokenAt != null && firstTokenAt >= requestSentAt) {
			stats.ttftMs = firstTokenAt - requestSentAt;
		}
		const rate = tokensPerSecond(message.usage?.output ?? 0, firstTokenAt, endedAt);
		if (rate !== undefined) stats.tps = rate;
		requestSentAt = undefined;
		firstTokenAt = undefined;
	});
}
