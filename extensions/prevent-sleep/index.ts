/**
 * prevent-sleep — keeps the computer awake while the agent is actively working,
 * so long runs (and self-driving goals) don't stall when your Mac would idle to
 * sleep. The wake lock is held from `agent_start` until the run `agent_settled`
 * (covering thinking, tool calls, retries, and compaction recovery) and released
 * when idle or on shutdown — so a genuinely blocked/paused goal still lets the
 * machine sleep.
 *
 * macOS uses `caffeinate -i -w <pid>`; all other platforms are a no-op.
 * Fully event-driven (no timers). Toggle with
 * `/prevent-sleep on|off`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { inhibitCommand } from "./inhibit.ts";

interface Deps {
	platform?: NodeJS.Platform;
	pid?: number;
	spawn?: typeof nodeSpawn;
}

export default function preventSleepExtension(pi: ExtensionAPI, deps: Deps = {}): void {
	const platform = deps.platform ?? process.platform;
	const pid = deps.pid ?? process.pid;
	const spawn = deps.spawn ?? nodeSpawn;
	const command = inhibitCommand(platform, pid);
	if (!command) return; // unsupported platform → no-op

	let enabled = true;
	let working = false;
	let inhibitor: ChildProcess | undefined;
	let starting = false;
	let failure: string | undefined;
	let closed = false;

	const start = (): void => {
		if (inhibitor) return;
		failure = undefined;
		starting = true;
		try {
			const child = spawn(command.cmd, command.args, { stdio: "ignore" });
			inhibitor = child;
			const clear = (reason: string): void => {
				if (inhibitor !== child) return;
				inhibitor = undefined;
				starting = false;
				failure = reason;
			};
			child.once("spawn", () => { if (inhibitor === child) starting = false; });
			child.once("error", () => clear("wake-lock helper could not start; check installation and permissions"));
			child.once("exit", (code, signal) => clear(`wake-lock helper exited (${signal ?? `code ${code ?? "unknown"}`})`));
		} catch {
			inhibitor = undefined; // caffeinate unavailable
			starting = false;
			failure = "wake-lock helper could not start; check installation and permissions";
		}
	};

	const stop = (): void => {
		const child = inhibitor;
		inhibitor = undefined;
		starting = false;
		try {
			child?.kill("SIGTERM");
		} catch {
			// already gone
		}
	};

	const sync = (): void => {
		if (!closed && enabled && working) start();
		else stop();
	};

	pi.registerCommand("prevent-sleep", {
		description: "Keep the computer awake while the agent is working",
		handler: async (args, ctx) => {
			const a = String(args ?? "").trim().toLowerCase();
			if (a === "on" || a === "off") {
				enabled = a === "on";
				sync();
				ctx.ui.notify(`Prevent-sleep ${enabled ? "enabled" : "disabled"}.`, "info");
			} else {
				const tool = basename(command.cmd);
				ctx.ui.notify(
					`Prevent-sleep is ${enabled ? "on" : "off"} — ${inhibitor ? `${tool} ${starting ? "starting" : "running"} for the active agent` : failure ? `unavailable: ${failure}` : working && enabled ? "no helper running" : "idle"}.`,
					"info",
				);
			}
		},
	});

	// agent_settled is the full run boundary: retries, compaction recovery, and a
	// self-driving goal's queued continuations stay covered by one assertion.
	pi.on("session_start", () => {
		stop();
		working = false;
		failure = undefined;
		closed = false;
	});
	pi.on("agent_start", () => {
		if (closed) return;
		working = true;
		sync();
	});
	pi.on("agent_settled", () => {
		working = false;
		sync();
	});
	pi.on("session_shutdown", () => {
		working = false;
		closed = true;
		stop();
	});
}
