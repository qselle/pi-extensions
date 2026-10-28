/**
 * Shell outcome for the bash headline. Structured details win; saved text is a
 * fallback for older results and for failures whose details were not kept.
 */
export type BashState = "running" | "ok" | "failed";

export interface BashOutcome {
	state: BashState;
	/** Failure detail such as `exit 2`, `SIGTERM` or `timed out`. */
	reason?: string;
	/** Formatted elapsed time; empty below one second. */
	elapsed?: string;
	/** Epoch milliseconds, for a running job's live elapsed time. */
	startedAt?: number;
}

const ACTIVE = new Set(["starting", "running", "stopping"]);
const FAILED = new Set(["failed", "timed-out", "stopped", "interrupted"]);
// Managed job summary: `[Ns elapsed · ]<icon> <name> · <status> · <elapsed>[ · exit N | · SIGNAL]`.
const MANAGED_HEADER = /^(?:\d+s elapsed · )?\S+ .* · (starting|running|stopping|completed|failed|stopped|timed-out|interrupted) · ([^·]+?)(?: · (?:exit (-?\d+)|(SIG[A-Z0-9]+)))?$/;
const NATIVE_REASONS: Array<[RegExp, string]> = [
	[/Command timed out after [\d.]+ seconds$/, "timed out"],
	[/Command aborted$/, "aborted"],
	[/Command terminated without an exit code$/, "terminated"],
];

const integer = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : undefined);
const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** Whole seconds, minutes and hours; sub-second runs show no elapsed time. */
export function formatElapsed(milliseconds: number): string {
	const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
	if (seconds < 1) return "";
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function contentText(result: any): string {
	const content = result?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("\n");
}

/**
 * Reads `exitCode`, `status`, `signal`, `durationMs` and `startedAt`/`endedAt`
 * from details when present, so native and managed executors share one headline.
 * Details win over `recordedMs`, Pi's execution time (1.1+): a managed job's own
 * timing outlasts the call that started it, and older results saved theirs there.
 */
export function bashOutcome(result: any, isError: boolean, recordedMs?: number): BashOutcome {
	const details = result?.details !== null && typeof result?.details === "object" ? result.details : {};
	const text = contentText(result).replace(/\s+$/, "");
	const header = text.split("\n", 1)[0]!.match(MANAGED_HEADER) ?? undefined;
	const status = typeof details.status === "string" ? details.status : header?.[1];
	const exitCode = integer(details.exitCode)
		?? (header?.[3] !== undefined ? Number(header[3]) : undefined)
		?? integer(Number(text.match(/Command exited with code (-?\d+)$/)?.[1] ?? Number.NaN));
	const signal = typeof details.signal === "string" && details.signal ? details.signal : header?.[4];
	const startedAt = time(details.startedAt);
	const endedAt = time(details.endedAt);
	const duration = time(details.durationMs) ?? (startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined) ?? time(recordedMs);
	const saved = header?.[2]?.trim();
	const elapsed = duration !== undefined ? formatElapsed(duration) : saved && /^\d+[smh]( \d+[smh])?$/.test(saved) && saved !== "0s" ? saved : undefined;
	if (status && ACTIVE.has(status)) return { state: "running", elapsed, startedAt };
	const failed = isError || (exitCode !== undefined && exitCode !== 0) || !!signal || (!!status && FAILED.has(status));
	if (!failed) return { state: "ok", elapsed };
	const reason = exitCode !== undefined && exitCode !== 0 ? `exit ${exitCode}`
		: signal ?? (status && status !== "failed" && FAILED.has(status) ? status.replace("-", " ")
			: NATIVE_REASONS.find(([pattern]) => pattern.test(text))?.[1]);
	return { state: "failed", reason, elapsed };
}
