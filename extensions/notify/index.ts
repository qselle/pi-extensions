/**
 * notify — native desktop notifications for agent activity, so you can
 * context-switch away and get pinged when there's something to look at.
 *
 * Fires a native OS banner (macOS `osascript`, Linux `notify-send`) plus a
 * terminal bell when:
 *   - the agent finishes a turn (with a short preview of the reply),
 *   - a tool the turn depended on failed (folded into the turn-complete ping),
 *   - the agent needs input (a `questionnaire` tool call).
 *
 * Only fires when the terminal tab is **unfocused** (tracked via focus-reporting
 * escape sequences on Ghostty/iTerm/Kitty/Warp/WezTerm), stays quiet while a
 * self-driving `goal` is active, dedupes identical pings within 5s, and is fully
 * event-driven (no timers). Toggle with `/notify` or ~/.pi/agent/notify.json.
 */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	bellSequence,
	isDuplicate,
	notifyCommand,
	parseFocusReports,
	preview,
	shouldEmit,
	supportsFocusReporting,
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
function textOf(message: any): string {
	const c = message?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.filter((p: any) => p?.type === "text")
		.map((p: any) => p.text ?? "")
		.join(" ");
}

const projectOf = (cwd: unknown, fallback: string): string =>
	String(cwd ?? "").split("/").filter(Boolean).pop() || fallback;

export default function notifyExtension(pi: ExtensionAPI): void {
	let cfg = loadConfig();
	const dedupe: DedupeState = {};
	let focusAware = false;
	let focused = true;
	let unsubscribe: (() => void) | undefined;
	let project = "pi";
	let finalResponse = "";
	let lastFailure: string | undefined;
	let goalActive = false;
	let notifiedThisRun = false;

	const send = (title: string, body: string): void => {
		if (!cfg.enabled || !shouldEmit(focusAware, focused)) return;
		if (isDuplicate(dedupe, title, body, Date.now())) return;
		if (cfg.bell) {
			try {
				process.stdout.write(bellSequence(!!process.env.TMUX));
			} catch {
				// terminal not writable
			}
		}
		if (cfg.banner) {
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
		}
	};

	pi.registerCommand("notify", {
		description: "Toggle native desktop notifications for agent activity",
		handler: async (args: string, ctx: any) => {
			const a = String(args ?? "").trim().toLowerCase();
			if (a === "on" || a === "off") {
				cfg = { ...cfg, enabled: a === "on" };
				saveEnabled(a === "on");
				ctx.ui.notify(`Desktop notifications ${a === "on" ? "enabled" : "disabled"}.`, "info");
			} else {
				ctx.ui.notify(
					`Desktop notifications are ${cfg.enabled ? "on (unfocused tabs only)" : "off"}. Use \`/notify on|off\`.`,
					"info",
				);
			}
		},
	});

	pi.on("session_start", (_event: any, ctx: any) => {
		project = projectOf(ctx?.cwd, "pi");
		finalResponse = "";
		lastFailure = undefined;
		notifiedThisRun = false;
		focused = true;
		focusAware = ctx?.mode === "tui" && supportsFocusReporting(process.env, !!process.stdout.isTTY);
		unsubscribe?.();
		unsubscribe = undefined;
		if (focusAware) {
			unsubscribe = ctx.ui.onTerminalInput((data: string) => {
				const p = parseFocusReports(data, focused);
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
		focused = true;
	});

	pi.on("agent_start", () => {
		finalResponse = "";
		lastFailure = undefined;
		notifiedThisRun = false;
	});

	pi.on("tool_execution_start", (event: any, ctx: any) => {
		if (event?.toolName !== "questionnaire") return;
		send(`${projectOf(ctx?.cwd, project)}: input needed`, "The agent is waiting for your answer.");
	});

	pi.on("tool_execution_end", (event: any) => {
		if (event?.isError) {
			const text = event?.result?.content?.find?.((p: any) => p?.type === "text")?.text;
			lastFailure = preview(text || `${event?.toolName ?? "tool"} failed`, 120);
		} else {
			lastFailure = undefined; // a later success clears the prior failure (recovered)
		}
	});

	pi.on("agent_end", (event: any) => {
		const assistant = [...(event?.messages ?? [])].reverse().find((m: any) => m?.role === "assistant");
		if (assistant) finalResponse = preview(textOf(assistant));
	});

	pi.on("agent_settled", (_event: any, ctx: any) => {
		if (notifiedThisRun || goalActive) return;
		notifiedThisRun = true;
		project = projectOf(ctx?.cwd, project);
		if (lastFailure) send(`${project}: tool failed`, lastFailure);
		else send(`${project}: done`, finalResponse || "Turn complete.");
	});

	// Best-effort: quiet routine turn-complete pings while a self-driving goal
	// runs (goal loops produce many turn boundaries). Harmless if the goal
	// extension never emits this event.
	try {
		pi.events.on("goal:changed", (data: unknown) => {
			const status = data && typeof data === "object" ? (data as { status?: unknown }).status : undefined;
			goalActive = status === "active";
		});
	} catch {
		// no event bus / goal extension — always notify
	}
}
