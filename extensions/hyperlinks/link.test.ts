import { afterEach, describe, expect, test } from "bun:test";
import {
  OSC8_CLOSE,
  closeDanglingLink,
  fileUri,
  getHyperlinkMode,
  hasDanglingLink,
  hasUriScheme,
  hyperlinkPath,
  hyperlinkUrl,
  hyperlinksEnabled,
  link,
  setHyperlinkMode,
  supportsHyperlinks,
  toAbsolutePath,
} from "./link.ts";

afterEach(() => setHyperlinkMode("auto"));

/**
 * Local width helper. Other test files in this repo mock @earendil-works/pi-tui
 * process-wide, so these tests must not depend on the real implementation.
 */
const plainText = (value: string): string =>
  value
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");

describe("fileUri", () => {
  test("builds a file URI and percent-encodes unsafe characters", () => {
    expect(fileUri("/tmp/a.ts")).toBe("file:///tmp/a.ts");
    expect(fileUri("/tmp/my file.ts")).toBe("file:///tmp/my%20file.ts");
  });
  test("keeps path separators intact", () => {
    expect(fileUri("/a/b/c.ts")).toBe("file:///a/b/c.ts");
  });
  test("normalizes Windows separators", () => {
    expect(fileUri("C:\\src\\a.ts")).toBe("file://C:/src/a.ts");
  });
});

describe("toAbsolutePath", () => {
  test("resolves relative paths against cwd", () => {
    expect(toAbsolutePath("src/a.ts", "/repo")).toBe("/repo/src/a.ts");
  });
  test("leaves absolute paths alone", () => {
    expect(toAbsolutePath("/abs/a.ts", "/repo")).toBe("/abs/a.ts");
  });
});

describe("supportsHyperlinks", () => {
  test("accepts a modern terminal on a tty", () => {
    expect(supportsHyperlinks({ TERM_PROGRAM: "ghostty", TERM: "xterm-256color" }, true)).toBe(true);
  });
  test("rejects Apple Terminal, which prints the URL literally", () => {
    expect(supportsHyperlinks({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }, true)).toBe(false);
  });
  test("rejects dumb terminals and non-ttys", () => {
    expect(supportsHyperlinks({ TERM: "dumb" }, true)).toBe(false);
    expect(supportsHyperlinks({ TERM: "xterm-256color" }, false)).toBe(false);
    expect(supportsHyperlinks({}, true)).toBe(false);
  });
  test("honors explicit overrides", () => {
    expect(supportsHyperlinks({ TERM: "dumb", FORCE_HYPERLINK: "1" }, false)).toBe(true);
    expect(supportsHyperlinks({ TERM: "xterm-256color", NO_HYPERLINK: "1" }, true)).toBe(false);
  });
});

describe("mode", () => {
  test("always and never override detection", () => {
    setHyperlinkMode("never");
    expect(getHyperlinkMode()).toBe("never");
    expect(hyperlinksEnabled({ TERM: "xterm-256color" }, true)).toBe(false);
    setHyperlinkMode("always");
    expect(hyperlinksEnabled({ TERM: "dumb" }, false)).toBe(true);
  });
});

describe("hyperlinkPath", () => {
  test("does not change the visible text", () => {
    setHyperlinkMode("always");
    const linked = hyperlinkPath("src/a.ts", "src/a.ts", "/repo");
    expect(plainText(linked)).toBe("src/a.ts");
    expect(linked).toContain("file:///repo/src/a.ts");
  });

  test("returns plain text when disabled", () => {
    setHyperlinkMode("never");
    expect(hyperlinkPath("src/a.ts", "src/a.ts", "/repo")).toBe("src/a.ts");
  });

  test("passes through empty display", () => {
    setHyperlinkMode("always");
    expect(hyperlinkPath("", "src/a.ts")).toBe("");
  });

  test("preserves inner styling", () => {
    setHyperlinkMode("always");
    const linked = hyperlinkPath("\x1b[31msrc/a.ts\x1b[0m", "/abs/src/a.ts");
    expect(linked).toContain("\x1b[31m");
    expect(plainText(linked)).toBe("src/a.ts");
  });
});

describe("dangling link repair", () => {
  test("a balanced link is left untouched", () => {
    const balanced = link("src/a.ts", "file:///abs/src/a.ts");
    expect(hasDanglingLink(balanced)).toBe(false);
    expect(closeDanglingLink(balanced)).toBe(balanced);
  });

  test("repairs the truncation case pi-tui produces", () => {
    // Width-aware truncation keeps the zero-width opener and drops the
    // terminator. This is that exact byte pattern, written out so the test does
    // not depend on a possibly-mocked truncateToWidth.
    const cut = "\x1b]8;;file:///abs/path.ts\x1b\\src/some/\x1b[0m\u2026\x1b[0m";
    expect(hasDanglingLink(cut)).toBe(true);

    const repaired = closeDanglingLink(cut);
    expect(hasDanglingLink(repaired)).toBe(false);
    expect(repaired.endsWith(OSC8_CLOSE)).toBe(true);
    // Repair must not change what the user sees.
    expect(plainText(repaired)).toBe(plainText(cut));
  });

  test("strips an opener truncated before its terminator", () => {
    const partial = "prefix \x1b]8;;file:///abs/pa";
    const repaired = closeDanglingLink(partial);
    expect(repaired).toBe("prefix ");
    expect(hasDanglingLink(repaired)).toBe(false);
  });

  test("leaves link-free text alone", () => {
    expect(closeDanglingLink("just text")).toBe("just text");
    expect(hasDanglingLink("just text")).toBe(false);
  });

  test("handles several links on one line", () => {
    const two = `${link("a", "file:///a")} and ${link("b", "file:///b")}`;
    expect(hasDanglingLink(two)).toBe(false);
    expect(closeDanglingLink(two)).toBe(two);
    const cut = `${link("a", "file:///a")} and \x1b]8;;file:///b\x1b\\b`;
    expect(hasDanglingLink(cut)).toBe(true);
    expect(closeDanglingLink(cut).endsWith(OSC8_CLOSE)).toBe(true);
  });
});

describe("URLs", () => {
  test("recognizes absolute URI schemes", () => {
    for (const value of ["https://x.com", "http://x.com", "mailto:a@b.c", "ssh://host", "vscode://file/x"]) {
      expect(hasUriScheme(value)).toBe(true);
    }
  });

  test("does not mistake paths or Windows drive letters for URIs", () => {
    for (const value of ["src/a.ts", "/abs/a.ts", "./a.ts", "C:\\src\\a.ts", "a:b"]) {
      expect(hasUriScheme(value)).toBe(false);
    }
  });

  test("hyperlinkUrl labels any URI", () => {
    setHyperlinkMode("always");
    const linked = hyperlinkUrl("PR #123", "https://github.com/qselle/pi-extensions/pull/123");
    expect(linked).toContain("https://github.com/qselle/pi-extensions/pull/123");
    expect(plainText(linked)).toBe("PR #123");
    expect(hasDanglingLink(linked)).toBe(false);
  });

  test("hyperlinkUrl respects the mode", () => {
    setHyperlinkMode("never");
    expect(hyperlinkUrl("PR #123", "https://x.com")).toBe("PR #123");
  });

  test("hyperlinkPath passes a URL through instead of resolving it as a path", () => {
    setHyperlinkMode("always");
    const linked = hyperlinkPath("openai.com", "https://openai.com", "/repo");
    expect(linked).toContain("https://openai.com");
    expect(linked).not.toContain("file:///repo");
  });

  test("hyperlinkPath still resolves real relative paths", () => {
    setHyperlinkMode("always");
    expect(hyperlinkPath("a.ts", "src/a.ts", "/repo")).toContain("file:///repo/src/a.ts");
  });
});
