export interface NotifyCommand {
	cmd: string;
	args: string[];
}

export function preview(text: string, limit = 140): string {
	const s = (text ?? "").replace(/\s+/g, " ").trim();
	return s.length > limit ? `${s.slice(0, Math.max(0, limit - 1))}…` : s;
}

function escapeAppleScript(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** spawn uses an argument vector; only the AppleScript literal needs escaping. */
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

/** Use OSC 777 for Ghostty/WezTerm and OSC 9 for iTerm2, with tmux passthrough. */
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

export function shouldEmit(focusAware: boolean, focused: boolean | undefined): boolean {
	return !focusAware || focused !== true;
}

/** Keep an unresolved operation visible until that same operation succeeds. */
export class ToolFailures {
	private readonly calls = new Map<string, string>();
	private readonly failures = new Map<string, string>();

	start(id: string, name: string, args: unknown): void {
		// These tools treat purpose as display metadata, so a reworded caption
		// must not prevent a successful retry from resolving the original failure.
		// Preserve unknown tools and nested fields: their purpose may be real input.
		const execution = PURPOSE_METADATA_TOOLS.has(name) && args && typeof args === "object" && !Array.isArray(args)
			? Object.fromEntries(Object.entries(args).filter(([key]) => key !== "purpose")) : args;
		this.calls.set(id, `${name}:${JSON.stringify(execution, (_key, value) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return value;
			return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
		})}`);
	}

	end(id: string, error: string | undefined): void {
		const key = this.calls.get(id) ?? `unobserved:${id}`;
		this.calls.delete(id);
		this.failures.delete(key);
		if (error) this.failures.set(key, error);
	}

	latest(): string | undefined { return [...this.failures.values()].at(-1); }
	clear(): void { this.calls.clear(); this.failures.clear(); }
}

const PURPOSE_METADATA_TOOLS = new Set([
	"bash", "read", "edit", "write", "grep", "find", "ls",
	"job_start", "job_output", "job_wait", "job_list", "job_write", "job_resize", "job_stop", "terminal_process",
]);

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
