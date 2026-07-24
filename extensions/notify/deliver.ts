/**
 * Pure delivery helpers for the notify extension: native-banner command
 * construction (with AppleScript escaping), the terminal-bell sequence,
 * focus-report parsing, preview truncation, and dedup. No pi/tui/node imports,
 * so it is fully unit-testable; the actual spawn/stdout writes live in index.ts.
 */

export interface NotifyCommand {
	cmd: string;
	args: string[];
}

/** Collapse whitespace and truncate to `limit` with an ellipsis. */
export function preview(text: string, limit = 140): string {
	const s = (text ?? "").replace(/\s+/g, " ").trim();
	return s.length > limit ? `${s.slice(0, Math.max(0, limit - 1))}…` : s;
}

/** Escape a string for an AppleScript double-quoted literal. */
function escapeAppleScript(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build the argv for a native OS banner, or undefined on unsupported platforms.
 * Args are passed to spawn() without a shell, so only the AppleScript string
 * literal needs escaping (macOS); notify-send takes the strings verbatim.
 */
export function notifyCommand(platform: NodeJS.Platform, title: string, body: string): NotifyCommand | undefined {
	const t = preview(title, 120);
	const b = preview(body, 200);
	if (platform === "darwin") {
		const script = `display notification "${escapeAppleScript(b)}" with title "${escapeAppleScript(t)}"`;
		return { cmd: "osascript", args: ["-e", script] };
	}
	if (platform === "linux") {
		return { cmd: "notify-send", args: ["--", t, b || " "] };
	}
	return undefined;
}

/** Terminal-bell escape sequence, wrapped in tmux passthrough when inside tmux. */
export function bellSequence(inTmux: boolean): string {
	const bell = "\x07";
	return inTmux ? `\u001bPtmux;${bell.replace(/\u001b/g, "\u001b\u001b")}\u001b\\` : bell;
}

/** Strip control chars that would break an OSC notification field. */
function oscField(s: string): string {
	return (s ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
}

/**
 * A terminal-owned desktop notification via an OSC escape, or undefined if the
 * terminal isn't known to support one. Ghostty/WezTerm use OSC 777 (title +
 * body); iTerm2 uses OSC 9 (body only). Because the terminal posts it, clicking
 * the notification focuses that terminal window (unlike osascript, which posts
 * from Script Editor). Wrapped in tmux passthrough when inside tmux.
 */
export function notificationEscape(
	env: NodeJS.ProcessEnv,
	title: string,
	body: string,
	inTmux = false,
): string | undefined {
	const id = `${env.TERM_PROGRAM ?? ""} ${env.TERM ?? ""}`.toLowerCase();
	const t = oscField(title);
	const b = oscField(body);
	let seq: string | undefined;
	if (["ghostty", "wezterm", "rxvt"].some((x) => id.includes(x))) {
		seq = `\u001b]777;notify;${t.replace(/;/g, ",") || "pi"};${b}\u0007`;
	} else if (id.includes("iterm")) {
		seq = `\u001b]9;${t && b ? `${t} \u2014 ${b}` : t || b}\u0007`;
	}
	if (!seq) return undefined;
	return inTmux ? `\u001bPtmux;${seq.replace(/\u001b/g, "\u001b\u001b")}\u001b\\` : seq;
}

const FOCUS_REPORT = /\u001b\[([IO])/g;

/** Terminals whose focus-reporting (CSI I / CSI O) we trust. */
export function supportsFocusReporting(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
	if (!isTty) return false;
	const id = `${env.TERM_PROGRAM ?? ""} ${env.TERM ?? ""}`.toLowerCase();
	return ["ghostty", "iterm", "kitty", "warp", "wezterm", "xterm"].some((t) => id.includes(t));
}

/** Strip focus-report sequences from input, returning the resulting focus state. */
export function parseFocusReports(
	data: string,
	focused: boolean,
): { data: string; focused: boolean; changed: boolean } {
	let next = focused;
	let changed = false;
	const rest = data.replace(FOCUS_REPORT, (_m, code: string) => {
		next = code === "I";
		changed = true;
		return "";
	});
	return { data: rest, focused: next, changed };
}

/** Notify only when the terminal isn't known to be focused. */
export function shouldEmit(focusAware: boolean, focused: boolean): boolean {
	return !focusAware || !focused;
}

export interface DedupeState {
	signature?: string;
	at?: number;
}

/** True if this (title, body) was already sent within `windowMs` (updates state). */
export function isDuplicate(
	state: DedupeState,
	title: string,
	body: string,
	now: number,
	windowMs = 5000,
): boolean {
	const sig = `${title}\u0000${body}`;
	if (state.signature === sig && now - (state.at ?? 0) < windowMs) return true;
	state.signature = sig;
	state.at = now;
	return false;
}
