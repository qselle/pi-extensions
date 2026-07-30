import { expect, test } from "bun:test";
import { clipboardCommands, copyText, type ClipboardCommand } from "./clipboard.ts";

test("selects fixed clipboard commands for supported platforms", () => {
  expect(clipboardCommands("darwin", {})).toEqual([{ command: "pbcopy", args: [] }]);
  expect(clipboardCommands("win32", {})).toEqual([{ command: "clip.exe", args: [] }]);
  expect(clipboardCommands("linux", {})).toEqual([
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ]);
  expect(clipboardCommands("linux", { TERMUX_VERSION: "1" })).toEqual([
    { command: "termux-clipboard-set", args: [] },
  ]);
  expect(clipboardCommands("freebsd", {})).toEqual([]);
});

test("tries clipboard backends in order and stops after success", async () => {
  const attempted: ClipboardCommand[] = [];
  const result = await copyText("safe excerpt", {
    platform: "linux",
    environment: {},
    runner: async (candidate, text) => {
      expect(text).toBe("safe excerpt");
      attempted.push(candidate);
      return candidate.command === "xclip";
    },
  });
  expect(result).toBe(true);
  expect(attempted.map((candidate) => candidate.command)).toEqual(["wl-copy", "xclip"]);
});

test("returns false without invoking a backend on unsupported platforms", async () => {
  let called = false;
  expect(await copyText("text", {
    platform: "freebsd",
    environment: {},
    runner: async () => {
      called = true;
      return true;
    },
  })).toBe(false);
  expect(called).toBe(false);
});
