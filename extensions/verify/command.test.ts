import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  applyTemplate,
  approxTokenCount,
  boundOutput,
  combineOutput,
  formatFailure,
  shellInvocation,
  shellQuote,
  spillOutput,
} from "./command.ts";
import type { VerifyCheck } from "./config.ts";

const check: VerifyCheck = { match: ["**/*.ts"], command: "bun test {dir}", name: "tests", timeoutMs: 60_000 };

describe("shellQuote", () => {
  test("single-quotes for POSIX and escapes embedded quotes", () => {
    expect(shellQuote("src/a.ts", "darwin")).toBe("'src/a.ts'");
    expect(shellQuote("my file.ts", "linux")).toBe("'my file.ts'");
    expect(shellQuote("it's.ts", "linux")).toBe("'it'\\''s.ts'");
  });
  test("double-quotes on Windows", () => {
    expect(shellQuote("my file.ts", "win32")).toBe('"my file.ts"');
  });
  test("neutralizes injection attempts in paths", () => {
    expect(shellQuote("a.ts; rm -rf /", "linux")).toBe("'a.ts; rm -rf /'");
  });
});

describe("applyTemplate", () => {
  test("substitutes file and dir, quoted", () => {
    expect(applyTemplate("bun test {dir}", { file: "a/b.ts", dir: "a" }, "linux")).toBe("bun test 'a'");
    expect(applyTemplate("tsc {file}", { file: "a/b.ts", dir: "a" }, "linux")).toBe("tsc 'a/b.ts'");
  });

  test("substitutes every occurrence", () => {
    expect(applyTemplate("x {file} y {file}", { file: "a.ts", dir: "." }, "linux")).toBe("x 'a.ts' y 'a.ts'");
  });

  test("{files} joins a quoted list and defaults to the single file", () => {
    expect(applyTemplate("lint {files}", { file: "a.ts", dir: ".", files: ["a.ts", "b c.ts"] }, "linux"))
      .toBe("lint 'a.ts' 'b c.ts'");
    expect(applyTemplate("lint {files}", { file: "a.ts", dir: "." }, "linux")).toBe("lint 'a.ts'");
  });

  test("leaves a command without placeholders alone", () => {
    expect(applyTemplate("cargo check", { file: "a.rs", dir: "." }, "linux")).toBe("cargo check");
  });
});

describe("shellInvocation", () => {
  test("uses $SHELL with -c on POSIX", () => {
    expect(shellInvocation("bun test", "linux", { SHELL: "/bin/zsh" })).toEqual({
      command: "/bin/zsh",
      args: ["-c", "bun test"],
    });
  });
  test("falls back to /bin/sh", () => {
    expect(shellInvocation("bun test", "darwin", {})).toEqual({ command: "/bin/sh", args: ["-c", "bun test"] });
  });
  test("uses cmd.exe on Windows", () => {
    expect(shellInvocation("bun test", "win32", {})).toEqual({ command: "cmd.exe", args: ["/c", "bun test"] });
  });
});

describe("combineOutput", () => {
  test("joins and trims both streams", () => {
    expect(combineOutput("out\n", " err ")).toBe("out\nerr");
    expect(combineOutput("", "")).toBe("");
    expect(combineOutput("only out", "")).toBe("only out");
  });
});

describe("approxTokenCount / boundOutput", () => {
  test("estimates tokens at roughly four characters each", () => {
    expect(approxTokenCount("12345678")).toBe(2);
  });

  test("short output passes through untouched", () => {
    expect(boundOutput("small", 100)).toEqual({ text: "small", truncated: false });
  });

  test("long output is truncated on line boundaries with a marker", () => {
    const text = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
    const bounded = boundOutput(text, 100);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).toContain("[… output truncated …]");
    expect(approxTokenCount(bounded.text)).toBeLessThanOrEqual(120);
    // Keeps the beginning and the end, which is where failures usually are.
    expect(bounded.text).toContain("line 0");
    expect(bounded.text).toContain("line 499");
  });

  test("a zero limit disables bounding", () => {
    expect(boundOutput("anything", 0).truncated).toBe(false);
  });
});

describe("spillOutput", () => {
  test("returns small output unchanged and writes nothing", () => {
    let wrote = false;
    const result = spillOutput("small", { tokenLimit: 100, write: () => { wrote = true; } });
    expect(result).toEqual({ text: "small", truncated: false });
    expect(wrote).toBe(false);
  });

  test("writes the full output and injects a bounded preview plus the path", () => {
    const text = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
    const written: { path: string; contents: string }[] = [];
    const result = spillOutput(text, {
      tokenLimit: 50,
      directory: "/tmp/verify-test",
      write: (path, contents) => written.push({ path, contents }),
    });
    expect(result.truncated).toBe(true);
    expect(result.path).toBe("/tmp/verify-test/verify-output.txt");
    expect(written[0]?.contents).toBe(text);
    expect(approxTokenCount(result.text)).toBeLessThanOrEqual(70);
  });

  test("really writes the file when no writer is injected", () => {
    const text = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
    const result = spillOutput(text, { tokenLimit: 50 });
    expect(result.path).toBeTruthy();
    expect(readFileSync(result.path!, "utf8")).toBe(text);
  });

  test("falls back to truncation when the write fails", () => {
    const text = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
    const result = spillOutput(text, {
      tokenLimit: 50,
      directory: "/tmp/verify-test",
      write: () => { throw new Error("read-only fs"); },
    });
    expect(result.truncated).toBe(true);
    expect(result.path).toBeUndefined();
    expect(result.text).toContain("[… output truncated …]");
  });
});

describe("formatFailure", () => {
  test("states the edit applied so the model does not retry the write", () => {
    const text = formatFailure({ check, command: "bun test 'a'", code: 1, timedOut: false, output: "1 failing" });
    expect(text).toContain("verify: tests failed (exit 1)");
    expect(text).toContain("command: bun test 'a'");
    expect(text).toContain("The edit was applied.");
    expect(text).toContain("fix the cause instead of repeating the edit");
    expect(text).toContain("1 failing");
  });

  test("reports a timeout with the configured duration", () => {
    const text = formatFailure({ check, command: "x", code: null, timedOut: true, output: "" });
    expect(text).toContain("timed out after 60s");
  });

  test("mentions the spill path when output was spilled", () => {
    const text = formatFailure({
      check, command: "x", code: 1, timedOut: false, output: "preview", spillPath: "/tmp/v/verify-output.txt",
    });
    expect(text).toContain("Full output: /tmp/v/verify-output.txt");
  });

  test("starts with a blank line so it appends cleanly to a tool result", () => {
    expect(formatFailure({ check, command: "x", code: 1, timedOut: false, output: "" }).startsWith("\n")).toBe(true);
  });
});
