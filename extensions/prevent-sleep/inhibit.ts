export interface InhibitCommand {
	cmd: string;
	args: string[];
}

/** caffeinate prevents idle system sleep and releases the assertion when Pi exits. */
export function inhibitCommand(platform: NodeJS.Platform, pid: number): InhibitCommand | undefined {
	if (platform === "darwin") {
		return { cmd: "/usr/bin/caffeinate", args: ["-i", "-w", String(pid)] };
	}
	return undefined;
}
