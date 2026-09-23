import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { separatorText } from "./format.ts";
import { addUsage, emptyStats, hasStats, tokensPerSecond, type TurnStats } from "./stats.ts";
import { isTelemetryStyle, telemetryStyle, TELEMETRY_CHANGED } from "../../lib/telemetry.ts";
import { isFirstOutputEvent } from "../turn-stats/timing.ts";

const ENTRY_TYPE = "worked-for-separator";

interface SeparatorEntry {
	seconds?: number;
	stats?: TurnStats;
}

export default function turnSeparatorExtension(pi: ExtensionAPI, now: () => number = () => performance.now()): void {
	// Timestamp of the first tool run since the last assistant message, if any.
	// Reset when a separator is emitted (below), not on turn_start — turn_start
	// re-fires per model round-trip and would wipe it before the post-tool message.
	let workStart: number | undefined;
	// Usage accumulated across every response in the current work block.
	let stats: TurnStats = emptyStats();
	// Per-response timing, used for ttft and tps of the latest response.
	let requestSentAt: number | undefined;
	let firstTokenAt: number | undefined;
	let style = telemetryStyle([]);
	let sessionId: string | undefined;
	let seen = new WeakSet<object>();
	pi.events?.on(TELEMETRY_CHANGED, (value: any) => {
		if (value?.sessionId === sessionId && isTelemetryStyle(value.style)) style = value.style;
	});

	const reset = () => {
		workStart = undefined;
		stats = emptyStats();
		requestSentAt = undefined;
		firstTokenAt = undefined;
		seen = new WeakSet();
	};

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, options, theme) => {
		const data = entry?.data as SeparatorEntry | undefined;
		return {
			invalidate() {},
			render(width: number): string[] {
				if (style === "hide") return [];
				const line = separatorText(data?.seconds, width, data?.stats, (color, text) => theme.fg(color, text), visibleWidth);
				return line ? [line] : [];
			},
		};
	});

	const restore = (_event: unknown, ctx: any) => { reset(); style = telemetryStyle(ctx?.sessionManager?.getBranch() ?? []); sessionId = ctx?.sessionManager?.getSessionId?.(); };
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	pi.on("session_shutdown", () => reset());
	pi.on("agent_start", () => reset());
	pi.on("agent_settled", () => reset());

	// The request-send moment. message_start fires when the first chunk arrives, so
	// anchoring ttft there measures ~0 and is meaningless.
	pi.on("before_provider_request", () => {
		requestSentAt = now();
		firstTokenAt = undefined;
	});

	pi.on("tool_execution_start", () => {
		if (workStart == null) workStart = now();
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		if (workStart != null) {
			const seconds = Math.max(0, Math.round((now() - workStart) / 1000));
			const data: SeparatorEntry = { seconds, stats: hasStats(stats) ? stats : undefined };
			workStart = undefined;
			stats = emptyStats();
			pi.appendEntry(ENTRY_TYPE, data);
		}
	});

	pi.on("message_update", (event) => {
		if (requestSentAt == null || firstTokenAt != null) return;
		if (isFirstOutputEvent(event.assistantMessageEvent)) firstTokenAt = now();
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message?.role !== "assistant" || seen.has(message)) return;
		seen.add(message);
		const endedAt = now();
		stats = addUsage(stats, message.usage);
		delete stats.ttftMs;
		delete stats.tps;
		// ttft/tps describe the latest response; averaging them across a block
		// would be meaningless, so the newest value wins. With no send anchor the
		// latency is unknown, which is reported by omitting it rather than as 0ms.
		if (requestSentAt != null && firstTokenAt != null && firstTokenAt >= requestSentAt) {
			stats.ttftMs = firstTokenAt - requestSentAt;
		}
		const rate = tokensPerSecond(message.usage?.output, firstTokenAt, endedAt);
		if (rate !== undefined) stats.tps = rate;
		requestSentAt = undefined;
		firstTokenAt = undefined;
	});
}
