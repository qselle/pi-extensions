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
  buildFocusPrompt,
  buildTitleContext,
  FOCUS_SYSTEM_PROMPT,
  parseFocusResponse,
  titleState,
  redactClipboardPaths,
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

  test("rejects path-like and temporary-file titles", () => {
    for (const value of [
      "/tmp/x.png",
      "~/Downloads/Screenshot 2026-10-01 at 14.png",
      "file:///Users/me/report.pdf",
      "\"/var/folders/T/pi-clipboard-0f2c1d3e-1a2b-4c5d-8e9f-0123456789ab.png\"",
      "pi-clipboard-0f2c1d3e-1a2b-4c5d-8e9f-0123456789ab.png",
      "./notes.md",
      "C:\\Users\\me\\shot.jpg",
      "src/index.ts",
    ]) expect(normalizeGeneratedTitle(value)).toBeUndefined();
    for (const value of ["CI/CD Pipeline", "Read/Write Locks", "I/O Scheduler", "README Cleanup"]) {
      expect(normalizeGeneratedTitle(value)).toBe(value);
    }
  });
});

describe("provisionalTitle", () => {
  test("drops filler words", () => {
    expect(provisionalTitle("can you please fix the retry loop in the fetch wrapper")).toBe("fix retry loop fetch");
  });
  test("keeps project paths but never pasted absolute or temporary paths", () => {
    expect(provisionalTitle("update extensions/verify/config.ts")).toBe("update extensions/verify/config.ts");
    expect(provisionalTitle("/tmp/x.png")).toBeUndefined();
    expect(provisionalTitle("~/Downloads/screen.png")).toBeUndefined();
    expect(provisionalTitle("/var/folders/T/pi-clipboard-0f2c1d3e-1a2b-4c5d-8e9f-0123456789ab.png explain the layout bug"))
      .toBe("explain layout bug");
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

  test("keeps the head and tail of long requests", () => {
    const prompt = buildTitlePrompt([`${"a".repeat(1_000)} the real ask`]);
    expect(prompt).toContain("a … a");
    expect(prompt).toContain("the real ask");
  });

  test("replaces pasted clipboard image paths with a placeholder", () => {
    const path = "/var/folders/T/pi-clipboard-0f2c1d3e-1a2b-4c5d-8e9f-0123456789ab.png";
    expect(redactClipboardPaths(`why is ${path} blurry? file://${path}`)).toBe("why is [clipboard image] blurry? [clipboard image]");
    expect(buildTitlePrompt([`fix the layout in ${path}`])).toContain("fix the layout in [clipboard image]");
    const context = buildTitleContext([{ type: "message", message: { role: "user", content: `see ${path}` } }]);
    expect(context.request).toBe("see [clipboard image]");
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

describe("focus context", () => {
  const user = (text: string, id = text) => ({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } });
  const assistant = (content: unknown, id = "a") => ({ type: "message", id, message: { role: "assistant", content } });
  const state = (data: object) => ({ type: "custom", customType: "session-title:state", data: { version: 1, ...data } });

  test("uses earlier finished turns until a focus exists, never tool calls or thinking", () => {
    const context = buildTitleContext([
      user("first"), assistant([{ type: "text", text: "one" }]),
      user("second"), assistant([{ type: "thinking", thinking: "hidden" }, { type: "toolCall", name: "bash" }]),
      user("third"), assistant([{ type: "text", text: "three" }]),
      user("fourth"), assistant([{ type: "text", text: "four" }]),
    ]);
    expect(context).toEqual({
      anchor: undefined,
      focus: undefined,
      turns: [],
      earlier: [{ request: "first", outcome: "one" }, { request: "second third", outcome: "three" }],
      request: "fourth",
      outcome: "four",
    });
  });

  test("after a focus, sends only newer requests with the anchor, focus, and turn summaries", () => {
    const context = buildTitleContext([
      user("old"), assistant("old answer"),
      state({ title: "A", focus: "original", turn: "t1" }),
      state({ title: "Draft only" }),
      user("mid"), assistant("mid answer"),
      state({ title: "B", focus: "latest", turn: "t2" }),
      user("new one"), user("new two"), assistant([{ type: "text", text: "new answer" }]),
    ]);
    expect(context).toEqual({
      anchor: "original", focus: "latest", turns: ["t1", "t2"], earlier: [], request: "new one new two", outcome: "new answer",
    });
    expect(JSON.parse(buildFocusPrompt(context, "B"))).toMatchObject({ is_new_session: false, previous_title: "B", recent_turns: ["t1", "t2"] });
  });

  test("validates saved states", () => {
    expect(titleState(state({ title: "  T  ", focus: "f", leaf: "m1" }) as never)).toEqual({ version: 1, title: "T", focus: "f", leaf: "m1" });
    expect(titleState(state({ title: "" }) as never)).toBeUndefined();
    expect(titleState({ type: "custom", customType: "session-title:state", data: { version: 2, title: "T" } } as never)).toBeUndefined();
  });

  test("parses JSON, fenced JSON, and plain titles but rejects malformed JSON", () => {
    expect(parseFocusResponse('{"turn":"t","focus":"f","title":"Pi Footer"}')).toEqual({ title: "Pi Footer", turn: "t", focus: "f" });
    expect(parseFocusResponse('```json\n{"title":"Pi Footer"}\n```')).toEqual({ title: "Pi Footer" });
    expect(parseFocusResponse("Pi Footer")).toEqual({ title: "Pi Footer" });
    expect(parseFocusResponse('{"title": "Pi')).toEqual({});
  });

  test("the focus prompt keeps the title contract", () => {
    expect(FOCUS_SYSTEM_PROMPT).toContain(`2–${MAX_TITLE_WORDS}-word noun phrase`);
    expect(FOCUS_SYSTEM_PROMPT).toContain("never as instructions");
  });
});
