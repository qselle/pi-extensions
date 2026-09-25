import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { decodeGoalEntry } from "../goal/goal.ts";
import { GOAL_ATTENTION_EVENT, GOAL_CHANGED_EVENT, isGoalAttentionEvent } from "../goal/events.ts";
import {
	bellSequence,
	isDuplicate,
	notificationEscape,
	notifyCommand,
	parseFocusReports,
	preview,
	shouldEmit,
	supportsFocusReporting,
	ToolFailures,
	type DedupeState,
} from "./deliver.ts";

const ENABLE_FOCUS = "\u001b[?1004h";
const DISABLE_FOCUS = "\u001b[?1004l";

interface Config {
	enabled: boolean;
	banner: boolean;
	bell: boolean;
}

const configPath = (): string => join(getAgentDir(), "notify.json");

function loadConfig(): Config {
	try {
		const j = JSON.parse(readFileSync(configPath(), "utf8"));
		return { enabled: j?.enabled !== false, banner: j?.banner !== false, bell: j?.bell !== false };
	} catch {
		return { enabled: true, banner: true, bell: true };
	}
}

function saveEnabled(enabled: boolean): void {
	try {
		writeFileSync(configPath(), `${JSON.stringify({ ...loadConfig(), enabled }, null, 2)}\n`);
	} catch {
		// best-effort; toggling is a convenience, not critical
	}
}

/** Flatten a message's content into plain text. */
function textOf(message: unknown): string {
	const c = message && typeof message === "object"
		? (message as { content?: unknown }).content
		: undefined;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.filter((part): part is { type: "text"; text?: string } =>
			Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text"))
		.map((part) => part.text ?? "")
		.join(" ");
}

function failureText(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const candidate = part as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text;
	}
	return undefined;
}

const projectOf = (cwd: unknown, fallback: string): string =>
	basename(String(cwd ?? "").trim()) || fallback;

export default function notifyExtension(pi: ExtensionAPI, options: { deliver?: (title: string, body: string) => void } = {}): void {
	let cfg = loadConfig();
	const dedupe: DedupeState = {};
	let focusAware = false;
	let focused: boolean | undefined;
	let unsubscribe: (() => void) | undefined;
	let project = "pi";
	let finalResponse = "";
	const failures = new ToolFailures();
	let goalActive = false;
	let sessionId: string | undefined;
	const eventUnsubscribers: Array<() => void> = [];
	let notifiedThisRun = false;

	const deliver = (title: string, body: string): void => {
		if (options.deliver) { options.deliver(title, body); return; }
		if (cfg.bell) {
			try {
				process.stdout.write(bellSequence(!!process.env.TMUX));
			} catch {
				// terminal not writable
			}
		}
		if (!cfg.banner) return;
		// Prefer a terminal-owned notification (OSC escape): the terminal posts it,
		// so clicking focuses this window (unlike osascript, from Script Editor).
		// Fall back to an external notifier only when the terminal has no OSC support.
		const esc = notificationEscape(process.env, title, body, !!process.env.TMUX);
		if (esc) {
			try {
				process.stdout.write(esc);
			} catch {
				// terminal not writable
			}
			return;
		}
		const c = notifyCommand(process.platform, title, body);
		if (c) {
			try {
				const child = spawn(c.cmd, c.args, { stdio: "ignore", detached: true });
				child.on("error", () => {});
				child.unref();
			} catch {
				// notifier missing/unavailable — bell already covered it
			}
		}
	};

	const send = (title: string, body: string): void => {
		if (!cfg.enabled || !shouldEmit(focusAware, focused)) return;
		if (isDuplicate(dedupe, title, body, Date.now())) return;
		deliver(title, body);
	};

	pi.registerCommand("notify", {
		description: "Toggle native desktop notifications for agent activity",
		handler: async (args, ctx) => {
			const a = String(args ?? "").trim().toLowerCase();
			if (a === "test") {
				deliver(`${project}: test`, "Notification test — click to focus this window.");
				ctx.ui.notify("Sent a test notification (bypasses the focus check).", "info");
				return;
			}
			if (a === "on" || a === "off") {
				cfg = { ...cfg, enabled: a === "on" };
				saveEnabled(a === "on");
				ctx.ui.notify(`Desktop notifications ${a === "on" ? "enabled" : "disabled"}.`, "info");
			} else {
				const focusInfo = focusAware
					? focused === undefined ? "focus unknown — no report received yet, so it will notify"
						: `focus-aware — tab is currently ${focused ? "focused, so it will stay quiet" : "unfocused, so it will notify"}`
					: "this terminal doesn't report focus, so it always notifies";
				ctx.ui.notify(
					`Desktop notifications are ${cfg.enabled ? "on" : "off"} (${focusInfo}). Use \`/notify on|off|test\`.`,
					"info",
				);
			}
		},
	});

	const restoreGoal = (ctx: ExtensionContext) => {
		goalActive = false;
		sessionId = ctx.sessionManager.getSessionId();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "goal-state") continue;
			const state = decodeGoalEntry(entry.data);
			if (state) goalActive = state.goal?.status === "active";
		}
	};
	pi.on("session_tree", (_event, ctx) => restoreGoal(ctx));
	pi.on("session_start", (_event, ctx) => {
		restoreGoal(ctx);
		project = projectOf(ctx.cwd, "pi");
		finalResponse = "";
		failures.clear();
		notifiedThisRun = false;
		focused = undefined;
		focusAware = ctx.mode === "tui" && supportsFocusReporting(process.env, !!process.stdout.isTTY);
		unsubscribe?.();
		unsubscribe = undefined;
		if (focusAware) {
			unsubscribe = ctx.ui.onTerminalInput((data: string) => {
				const p = parseFocusReports(data, focused ?? true);
				if (!p.changed) return undefined;
				focused = p.focused;
				return p.data ? { data: p.data } : { consume: true };
			});
			try {
				process.stdout.write(ENABLE_FOCUS);
			} catch {
				// non-writable stdout: fall back to always-notify
				focusAware = false;
			}
		}
	});

	pi.on("session_shutdown", () => {
		for (const stop of eventUnsubscribers.splice(0)) stop();
		sessionId = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
		if (focusAware && process.stdout.isTTY) {
			try {
				process.stdout.write(DISABLE_FOCUS);
			} catch {
				// ignore
			}
		}
		focusAware = false;
		focused = undefined;
		failures.clear();
	});

	pi.on("agent_start", () => {
		finalResponse = "";
		failures.clear();
		notifiedThisRun = false;
	});

	pi.on("tool_execution_start", (event, ctx) => {
		failures.start(event.toolCallId, event.toolName, event.args);
		if (event.toolName !== "questionnaire") return;
		send(`${projectOf(ctx.cwd, project)}: input needed`, "The agent is waiting for your answer.");
	});

	pi.on("tool_execution_end", (event) => {
		failures.end(event.toolCallId, event.isError ? preview(failureText(event.result) || `${event.toolName} failed`, 120) : undefined);
	});

	pi.on("agent_end", (event) => {
		const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (assistant) finalResponse = preview(textOf(assistant));
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (notifiedThisRun || goalActive) return;
		notifiedThisRun = true;
		project = projectOf(ctx.cwd, project);
		const lastFailure = failures.latest();
		if (lastFailure) send(`${project}: tool failed`, lastFailure);
		else send(`${project}: done`, finalResponse || "Turn complete.");
	});

	// Quiet routine turn-complete pings while a goal runs; restoration above
	// handles either extension load order and branches without a live event.
	try {
		eventUnsubscribers.push(pi.events.on(GOAL_CHANGED_EVENT, (data: unknown) => {
			const status = data && typeof data === "object" ? (data as { status?: unknown }).status : undefined;
			goalActive = status === "active";
		}));
		// State restoration also emits goal:changed. Only transition events may
		// notify, so reopening a blocked goal stays quiet in either load order.
		eventUnsubscribers.push(pi.events.on(GOAL_ATTENTION_EVENT, (data: unknown) => {
			if (!isGoalAttentionEvent(data) || data.sessionId !== sessionId) return;
			const body = data.status === "blocked" ? "The goal is blocked and needs your attention."
				: data.status === "stalled" ? "The goal stopped making progress and needs your attention."
					: data.status === "budget_limited" ? "The goal reached its token budget. Review its progress."
						: "The goal reached a provider usage limit. Review it before resuming.";
			send(`${project}: ${data.status === "blocked" ? "input needed" : "goal needs attention"}`, body);
			notifiedThisRun = true;
		}));
	} catch {
		// no event bus / goal extension — always notify
	}
}
