/**
 * Pure platform logic for prevent-sleep: the long-running command that holds an
 * idle-sleep assertion, per platform. No imports, so it is unit-testable.
 */

export interface InhibitCommand {
	cmd: string;
	args: string[];
}

/**
 * The "keep awake" command for this platform, or undefined when unsupported.
 *
 * - macOS: `caffeinate -i -w <pid>` — prevents idle *system* sleep (not the
 *   display) and ties the assertion to the pi process, so it's released if pi
 *   exits unexpectedly.
 * - Linux: `systemd-inhibit --what=idle:sleep --mode=block … sleep infinity` —
 *   holds an idle+sleep inhibitor until the helper is killed.
 */
export function inhibitCommand(platform: NodeJS.Platform, pid: number): InhibitCommand | undefined {
	if (platform === "darwin") {
		return { cmd: "/usr/bin/caffeinate", args: ["-i", "-w", String(pid)] };
	}
	if (platform === "linux") {
		return {
			cmd: "systemd-inhibit",
			args: ["--what=idle:sleep", "--why=pi agent is working", "--mode=block", "sleep", "infinity"],
		};
	}
	return undefined;
}
