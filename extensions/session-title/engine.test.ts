import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MODEL_PREFERENCES,
  MAX_TITLE_CHARS,
  MAX_TITLE_WORDS,
  buildTitlePrompt,
  isCredibleTitle,
  normalizeTitle,
  pickAnchor,
  provisionalTitle,
  selectTitleModel,
  shouldGenerate,
  TITLE_SYSTEM_PROMPT,
} from "./engine.ts";

describe("normalizeTitle", () => {
  test("keeps a good title as-is", () => {
    expect(normalizeTitle("Refactor auth middleware")).toBe("Refactor auth middleware");
  });

  test("strips quotes, markdown, labels, and trailing punctuation", () => {
    expect(normalizeTitle('"Fix retry loop"')).toBe("Fix retry loop");
    expect(normalizeTitle("**Fix retry loop**")).toBe("Fix retry loop");
    expect(normalizeTitle("Title: Fix retry loop.")).toBe("Fix retry loop");
    expect(normalizeTitle("`Fix retry loop`")).toBe("Fix retry loop");
  });

  test("takes only the first line of a chatty answer", () => {
    expect(normalizeTitle("Fix retry loop\nThis title reflects the work.")).toBe("Fix retry loop");
  });

  test("caps words and characters", () => {
    expect(normalizeTitle("one two three four five six seven")).toBe("one two three four five");
    const long = normalizeTitle("Supercalifragilisticexpialidocious extraordinarily verbose");
    expect(long!.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(long!.endsWith("…")).toBe(true);
  });

  test("rejects generic and empty titles", () => {
    for (const value of ["", "   ", "untitled", "New session", "chat", "TEST", 42, undefined, null]) {
      expect(normalizeTitle(value as never)).toBeUndefined();
    }
  });

  test("collapses whitespace", () => {
    expect(normalizeTitle("  Fix   retry \t loop ")).toBe("Fix retry loop");
  });
});

describe("provisionalTitle", () => {
  test("drops filler words", () => {
    expect(provisionalTitle("can you please fix the retry loop in the fetch wrapper")).toBe("fix retry loop fetch");
  });

  test("keeps paths and identifiers", () => {
    expect(provisionalTitle("update extensions/verify/config.ts")).toBe("update extensions/verify/config.ts");
  });

  test("ignores code blocks and urls", () => {
    expect(provisionalTitle("look at ```const x = 1``` https://example.com/x and fix parsing"))
      .toBe("look fix parsing");
  });

  test("falls back to raw words when everything is filler", () => {
    expect(provisionalTitle("can you do it")).toBeTruthy();
  });

  test("returns undefined for empty or symbol-only input", () => {
    expect(provisionalTitle("")).toBeUndefined();
    expect(provisionalTitle("!!! ???")).toBeUndefined();
  });

  test("respects the word budget", () => {
    expect(provisionalTitle("alpha beta gamma delta epsilon zeta", 3)).toBe("alpha beta gamma");
  });
});

describe("TITLE_SYSTEM_PROMPT", () => {
  test("states the hard constraints the normalizer enforces", () => {
    expect(TITLE_SYSTEM_PROMPT).toContain(`${MAX_TITLE_WORDS} words`);
    expect(TITLE_SYSTEM_PROMPT).toContain(`${MAX_TITLE_CHARS} characters`);
    expect(TITLE_SYSTEM_PROMPT).toContain("repeat that title exactly");
  });
});

describe("buildTitlePrompt", () => {
  test("includes the anchor, recent requests, and current title", () => {
    const prompt = buildTitlePrompt({
      anchor: "add hyperlinks to tool blocks",
      recent: ["now add stats", "explain in and out"],
      currentTitle: "Clickable paths",
    });
    expect(prompt).toContain("current_title: Clickable paths");
    expect(prompt).toContain("first_request: add hyperlinks to tool blocks");
    expect(prompt).toContain("- now add stats");
    expect(prompt).toContain("- explain in and out");
    expect(prompt.trimEnd().endsWith("Title:")).toBe(true);
  });

  test("keeps only the newest requests", () => {
    const recent = Array.from({ length: 20 }, (_, index) => `request ${index}`);
    const prompt = buildTitlePrompt({ recent });
    expect(prompt).toContain("request 19");
    expect(prompt).not.toContain("request 5");
  });

  test("clips long text and bounds the whole prompt", () => {
    const prompt = buildTitlePrompt({
      anchor: "x".repeat(5_000),
      recent: ["y".repeat(5_000)],
    });
    expect(prompt.length).toBeLessThanOrEqual(4_100);
    expect(prompt).toContain("…");
  });

  test("omits empty sections", () => {
    const prompt = buildTitlePrompt({ recent: [] });
    expect(prompt).not.toContain("current_title");
    expect(prompt).not.toContain("recent_requests");
  });

  test("never includes assistant or tool content, only what the user wrote", () => {
    // The caller passes user text only; this documents the contract.
    const prompt = buildTitlePrompt({ anchor: "user asked this", recent: ["and this"] });
    expect(prompt.split("\n").every((line) => !line.startsWith("assistant"))).toBe(true);
  });
});

describe("shouldGenerate", () => {
  test("titles once after the first user turn", () => {
    expect(shouldGenerate({ userTurns: 0 })).toBe(false);
    expect(shouldGenerate({ userTurns: 1 })).toBe(true);
  });

  test("waits for the refresh interval afterwards", () => {
    expect(shouldGenerate({ userTurns: 3, titledAtTurn: 1 }, 5)).toBe(false);
    expect(shouldGenerate({ userTurns: 6, titledAtTurn: 1 }, 5)).toBe(true);
  });

  test("never runs again after a manual rename", () => {
    expect(shouldGenerate({ userTurns: 99, titledAtTurn: 1, manual: true })).toBe(false);
  });

  test("treats a zero interval as one turn", () => {
    expect(shouldGenerate({ userTurns: 2, titledAtTurn: 1 }, 0)).toBe(true);
  });
});

describe("selectTitleModel", () => {
  const registry = (available: string[]) => (provider: string, id: string) =>
    available.includes(`${provider}/${id}`) ? { provider, id } : undefined;

  test("uses the first available preference", () => {
    const model = selectTitleModel(registry(["anthropic/claude-haiku-4-5"]));
    expect(model).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
  });

  test("prefers cheaper models earlier in the list", () => {
    expect(DEFAULT_MODEL_PREFERENCES[0]).toContain("haiku");
    expect(DEFAULT_MODEL_PREFERENCES.at(-1)).toContain("nova-micro");
  });

  test("honors an explicit override", () => {
    const model = selectTitleModel(registry(["openai/gpt-4.1-mini", "anthropic/claude-haiku-4-5"]), {
      override: "openai/gpt-4.1-mini",
    });
    expect(model).toEqual({ provider: "openai", id: "gpt-4.1-mini" });
  });

  test("keeps model ids that contain slashes", () => {
    const model = selectTitleModel(registry(["openrouter/meta/llama-3.1-8b"]), {
      override: "openrouter/meta/llama-3.1-8b",
    });
    expect(model).toEqual({ provider: "openrouter", id: "meta/llama-3.1-8b" });
  });

  test("falls back to the session model when nothing matches", () => {
    const fallback = { provider: "amazon-bedrock", id: "opus" };
    expect(selectTitleModel(registry([]), { fallback })).toBe(fallback);
    expect(selectTitleModel(registry([]), { override: "a/b", fallback })).toBe(fallback);
  });

  test("returns undefined with no match and no fallback", () => {
    expect(selectTitleModel(registry([]))).toBeUndefined();
  });

  test("ignores malformed preferences", () => {
    expect(selectTitleModel(registry(["a/b"]), { preferences: ["nope", "/x", "a/b"] })).toEqual({
      provider: "a", id: "b",
    });
  });
});

describe("junk-title resistance (regression: title stuck on 'tig')", () => {
  test("a fragment is not credible", () => {
    for (const value of ["tig", "abc", "x", "hello", undefined]) {
      expect(isCredibleTitle(value as never)).toBe(false);
    }
  });

  test("a real title is credible", () => {
    expect(isCredibleTitle("Clickable file paths")).toBe(true);
    expect(isCredibleTitle("Hyperlinks")).toBe(true);
  });

  test("a non-credible current title is withheld, so the model replaces it", () => {
    const prompt = buildTitlePrompt({ anchor: "add stats to the rule", recent: [], currentTitle: "tig" });
    expect(prompt).not.toContain("current_title");
  });

  test("a credible current title is kept for continuity", () => {
    const prompt = buildTitlePrompt({ anchor: "a", recent: [], currentTitle: "Clickable file paths" });
    expect(prompt).toContain("current_title: Clickable file paths");
  });

  test("the system prompt tells the model to replace a fragment", () => {
    expect(TITLE_SYSTEM_PROMPT).toContain("Replace the current title when it is vague, truncated, a fragment");
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
