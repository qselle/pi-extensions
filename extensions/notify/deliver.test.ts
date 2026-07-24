import { describe, expect, test } from "bun:test";
import {
	bellSequence,
	isDuplicate,
	notificationEscape,
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

describe("notificationEscape", () => {
	test("Ghostty/WezTerm post OSC 777 (title; body) — terminal-owned, click-to-focus", () => {
		expect(notificationEscape({ TERM_PROGRAM: "ghostty" }, "pi: done", "shipped it")).toBe(
			"\u001b]777;notify;pi: done;shipped it\u0007",
		);
		expect(notificationEscape({ TERM: "wezterm" }, "t", "b")).toBe("\u001b]777;notify;t;b\u0007");
	});
	test("iTerm2 posts OSC 9 (body only, title folded in)", () => {
		expect(notificationEscape({ TERM_PROGRAM: "iTerm.app" }, "pi", "done")).toBe("\u001b]9;pi \u2014 done\u0007");
	});
	test("unknown terminals get no escape (caller falls back to a notifier)", () => {
		expect(notificationEscape({ TERM_PROGRAM: "Apple_Terminal" }, "t", "b")).toBeUndefined();
	});
	test("tmux passthrough wraps and doubles ESC", () => {
		const out = notificationEscape({ TERM_PROGRAM: "ghostty" }, "t", "b", true);
		expect(out?.startsWith("\u001bPtmux;")).toBe(true);
		expect(out?.endsWith("\u001b\\")).toBe(true);
	});
	test("strips control chars; semicolons in the title become commas", () => {
		expect(notificationEscape({ TERM_PROGRAM: "ghostty" }, "a;b", "x\ny")).toBe("\u001b]777;notify;a,b;x y\u0007");
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
