import { describe, expect, test } from "bun:test";
import {
  MAX_TITLE_CHARS,
  MAX_TITLE_WORDS,
  buildTitlePrompt,
  normalizeGeneratedTitle,
  normalizeManualTitle,
  normalizeTitle,
  pickAnchor,
  provisionalTitle,
  TITLE_SYSTEM_PROMPT,
} from "./engine.ts";

test("manual names preserve wording, remove controls, and cap Unicode characters", () => {
  expect(normalizeManualTitle("\x1b]0;bad\x07\x1b[31mMy  title:\nwith five more words!\x1b[0m")).toBe("My title: with five more words!");
  expect(normalizeManualTitle("\t\n")).toBeUndefined();
  expect(normalizeManualTitle("Session")).toBe("Session");
  const title = normalizeManualTitle("🐈".repeat(130))!;
  expect([...title]).toHaveLength(120);
  expect(title.endsWith("…")).toBe(true);
});

describe("normalizeTitle", () => {
  test("keeps a good title as-is", () => {
    expect(normalizeTitle("Refactor auth middleware")).toBe("Refactor auth middleware");
  });

  test("strips quotes, markdown, labels, and trailing punctuation", () => {
    expect(normalizeTitle('"Fix retry loop"')).toBe("Fix retry loop");
    expect(normalizeTitle("**Fix retry loop**")).toBe("Fix retry loop");
    expect(normalizeTitle("Title: Fix retry loop.")).toBe("Fix retry loop");
  });

  test("takes only the first line of a chatty answer", () => {
    expect(normalizeTitle("Fix retry loop\nThis reflects the work.")).toBe("Fix retry loop");
  });

  test("caps words and characters", () => {
    expect(normalizeTitle("one two three four five six")).toBe("one two three four");
    const long = normalizeTitle("Supercalifragilisticexpialidocious extraordinarily verbose title");
    expect(long!.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
  });

  test("rejects generic and empty answers, so a bad answer changes nothing", () => {
    for (const value of ["", "  ", "untitled", "New session", "chat", "hello", 42, undefined, null]) {
      expect(normalizeTitle(value as never)).toBeUndefined();
    }
  });
});

describe("normalizeGeneratedTitle", () => {
  test("removes a leading task verb from model output", () => {
    expect(normalizeGeneratedTitle("Improve Pi Footer")).toBe("Pi Footer");
    expect(normalizeGeneratedTitle("Title: Update Session Naming.")).toBe("Session Naming");
  });

  test("keeps an existing noun phrase intact", () => {
    expect(normalizeGeneratedTitle("Pi Footer Redesign")).toBe("Pi Footer Redesign");
  });
});

describe("provisionalTitle", () => {
  test("drops filler words", () => {
    expect(provisionalTitle("can you please fix the retry loop in the fetch wrapper")).toBe("fix retry loop fetch");
  });
  test("keeps paths", () => {
    expect(provisionalTitle("update extensions/verify/config.ts")).toBe("update extensions/verify/config.ts");
  });
  test("ignores code blocks and urls", () => {
    expect(provisionalTitle("look at ```const x = 1``` https://example.com and fix parsing")).toBe("look fix parsing");
  });
  test("returns nothing for greetings or symbols", () => {
    expect(provisionalTitle("hello")).toBeUndefined();
    expect(provisionalTitle("!!! ???")).toBeUndefined();
  });
});

describe("pickAnchor", () => {
  test("skips greetings and picks the first real request", () => {
    expect(pickAnchor(["hello", "hi", "add hyperlinks to tool blocks"])).toBe("add hyperlinks to tool blocks");
  });
  test("keeps the first text when nothing is substantive", () => {
    expect(pickAnchor(["hello", "hi"])).toBe("hello");
  });
  test("handles an empty list", () => {
    expect(pickAnchor([])).toBeUndefined();
  });
});

describe("buildTitlePrompt", () => {
  test("anchors on the first real request and lists the rest", () => {
    const prompt = buildTitlePrompt(["hello", "add hyperlinks", "now add stats"]);
    expect(prompt).toContain("first_request: add hyperlinks");
    expect(prompt).toContain("- hello");
    expect(prompt).toContain("- now add stats");
    expect(prompt.trimEnd().endsWith("Title:")).toBe(true);
  });

  test("never sends a current title, so a bad title cannot perpetuate itself", () => {
    expect(buildTitlePrompt(["a", "b"])).not.toContain("current_title");
  });

  test("keeps only the newest requests", () => {
    const prompt = buildTitlePrompt(Array.from({ length: 20 }, (_, index) => `request ${index}`));
    expect(prompt).toContain("request 19");
    expect(prompt).not.toContain("request 3");
  });

  test("clips long text and bounds the whole prompt", () => {
    const prompt = buildTitlePrompt(["x".repeat(5_000), "y".repeat(5_000)]);
    expect(prompt.length).toBeLessThanOrEqual(4_100);
    expect(prompt).toContain("…");
  });

  test("handles an empty conversation", () => {
    expect(buildTitlePrompt([]).trim()).toBe("Title:");
  });
});

describe("TITLE_SYSTEM_PROMPT", () => {
  test("states the constraints the normalizer enforces", () => {
    expect(TITLE_SYSTEM_PROMPT).toContain(`${MAX_TITLE_WORDS} words`);
    expect(TITLE_SYSTEM_PROMPT).toContain(`${MAX_TITLE_CHARS} characters`);
  });
  test("asks for a noun phrase rather than a leading task verb", () => {
    expect(TITLE_SYSTEM_PROMPT).toContain("specific noun phrase");
    expect(TITLE_SYSTEM_PROMPT).toContain("Do not begin with a task verb");
  });
});
