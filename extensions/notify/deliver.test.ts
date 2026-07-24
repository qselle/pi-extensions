import { describe, expect, test } from "bun:test";
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

describe("preview", () => {
	test("collapses whitespace and truncates with an ellipsis", () => {
		expect(preview("  a\n\n b   c ")).toBe("a b c");
		expect(preview("abcdef", 4)).toBe("abc…");
		expect(preview("abcd", 4)).toBe("abcd");
		expect(preview(undefined as any)).toBe("");
	});
});

describe("notifyCommand", () => {
	test("macOS builds an osascript display-notification, escaping the string", () => {
		const c = notifyCommand("darwin", 'pi: done', 'said "hi" \\ bye');
		expect(c?.cmd).toBe("osascript");
		expect(c?.args[0]).toBe("-e");
		expect(c?.args[1]).toBe('display notification "said \\"hi\\" \\\\ bye" with title "pi: done"');
	});

	test("Linux builds a notify-send with -- guard", () => {
		expect(notifyCommand("linux", "t", "b")).toEqual({ cmd: "notify-send", args: ["--", "t", "b"] });
	});

	test("unsupported platform yields no command", () => {
		expect(notifyCommand("win32", "t", "b")).toBeUndefined();
	});
});

describe("bellSequence", () => {
	test("bare BEL, or tmux passthrough inside tmux", () => {
		expect(bellSequence(false)).toBe("\x07");
		expect(bellSequence(true)).toBe("\u001bPtmux;\x07\u001b\\");
	});
});

describe("focus", () => {
	test("supportsFocusReporting needs a tty and a known terminal", () => {
		expect(supportsFocusReporting({ TERM_PROGRAM: "ghostty" }, true)).toBe(true);
		expect(supportsFocusReporting({ TERM: "xterm-kitty" }, true)).toBe(true);
		expect(supportsFocusReporting({ TERM_PROGRAM: "ghostty" }, false)).toBe(false);
		expect(supportsFocusReporting({ TERM_PROGRAM: "dumb" }, true)).toBe(false);
	});

	test("parseFocusReports strips CSI I/O and reports the new state", () => {
		expect(parseFocusReports("\u001b[Ohello", true)).toEqual({ data: "hello", focused: false, changed: true });
		expect(parseFocusReports("x\u001b[Iy", false)).toEqual({ data: "xy", focused: true, changed: true });
		expect(parseFocusReports("plain", true)).toEqual({ data: "plain", focused: true, changed: false });
	});

	test("shouldEmit fires unless we know the tab is focused", () => {
		expect(shouldEmit(false, true)).toBe(true); // not focus-aware → always
		expect(shouldEmit(true, true)).toBe(false); // focused → stay quiet
		expect(shouldEmit(true, false)).toBe(true); // unfocused → notify
	});
});

describe("isDuplicate", () => {
	test("suppresses an identical ping inside the window, allows it after", () => {
		const s: DedupeState = {};
		expect(isDuplicate(s, "t", "b", 1000)).toBe(false); // first
		expect(isDuplicate(s, "t", "b", 2000)).toBe(true); // within 5s
		expect(isDuplicate(s, "t", "b", 7000)).toBe(false); // window elapsed
		expect(isDuplicate(s, "t", "other", 7100)).toBe(false); // different body
	});
});
