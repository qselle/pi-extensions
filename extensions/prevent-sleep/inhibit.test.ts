import { describe, expect, test } from "bun:test";
import { inhibitCommand } from "./inhibit.ts";

describe("inhibitCommand", () => {
	test("macOS ties the idle-sleep lock to the pi pid", () => {
		expect(inhibitCommand("darwin", 4242)).toEqual({ cmd: "/usr/bin/caffeinate", args: ["-i", "-w", "4242"] });
	});

	test("Linux uses systemd-inhibit against idle + sleep", () => {
		const c = inhibitCommand("linux", 1);
		expect(c?.cmd).toBe("systemd-inhibit");
		expect(c?.args).toContain("--what=idle:sleep");
		expect(c?.args.slice(-2)).toEqual(["sleep", "infinity"]);
	});

	test("other platforms have no inhibitor (extension no-ops)", () => {
		expect(inhibitCommand("win32", 1)).toBeUndefined();
		expect(inhibitCommand("freebsd" as NodeJS.Platform, 1)).toBeUndefined();
	});
});
