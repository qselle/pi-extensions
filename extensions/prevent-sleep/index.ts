/**
 * prevent-sleep — keeps the computer awake while the agent is actively working,
 * so long runs (and self-driving goals) don't stall when your Mac would idle to
 * sleep. The wake lock is held from `agent_start` until the run `agent_settled`
 * (covering thinking, tool calls, retries, and compaction recovery) and released
 * when idle or on shutdown — so a genuinely blocked/paused goal still lets the
 * machine sleep.
 *
 * macOS uses `caffeinate -i -w <pid>`; Linux uses `systemd-inhibit`; other
 * platforms are a no-op. Fully event-driven (no timers). Toggle with
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

	const start = (): void => {
		if (inhibitor) return;
		try {
			const child = spawn(command.cmd, command.args, { stdio: "ignore" });
			inhibitor = child;
			const clear = (): void => {
				if (inhibitor === child) inhibitor = undefined;
			};
			child.once("error", clear);
			child.once("exit", clear);
		} catch {
			inhibitor = undefined; // caffeinate/systemd-inhibit unavailable
		}
	};

	const stop = (): void => {
		const child = inhibitor;
		inhibitor = undefined;
		try {
			child?.kill("SIGTERM");
		} catch {
			// already gone
		}
	};

	const sync = (): void => {
		if (enabled && working) start();
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
					`Prevent-sleep is ${enabled ? "on" : "off"} — currently ${inhibitor ? `holding the wake lock (${tool}, agent working)` : "idle"}.`,
					"info",
				);
			}
		},
	});

	// agent_settled is the full run boundary: retries, compaction recovery, and a
	// self-driving goal's queued continuations stay covered by one assertion.
	pi.on("agent_start", () => {
		working = true;
		sync();
	});
	pi.on("agent_settled", () => {
		working = false;
		sync();
	});
	pi.on("session_shutdown", () => {
		working = false;
		enabled = false;
		stop();
	});
}
