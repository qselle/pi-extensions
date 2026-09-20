import { describe, expect, test } from "bun:test";
import { inhibitCommand } from "./inhibit.ts";

describe("inhibitCommand", () => {
	test("macOS ties the idle-sleep lock to the pi pid", () => {
		expect(inhibitCommand("darwin", 4242)).toEqual({ cmd: "/usr/bin/caffeinate", args: ["-i", "-w", "4242"] });
	});

	test("Linux has no inhibitor", () => {
		expect(inhibitCommand("linux", 1)).toBeUndefined();
	});

	test("other platforms have no inhibitor (extension no-ops)", () => {
		expect(inhibitCommand("win32", 1)).toBeUndefined();
		expect(inhibitCommand("freebsd" as NodeJS.Platform, 1)).toBeUndefined();
	});
});
