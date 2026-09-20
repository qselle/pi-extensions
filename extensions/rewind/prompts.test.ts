import { expect, test } from "bun:test";
import { rewindPrompts } from "./prompts.ts";

const entry = (id: string, content: unknown) => ({ id, type: "message", message: { role: "user", content } });

test("rewind preserves duplicate prompts as distinct chronological targets", () => {
  const prompts = rewindPrompts([entry("a", "same"), entry("b", "same")]);
  expect(prompts.map((p) => p.id)).toEqual(["b", "a"]);
  expect(prompts.map((p) => p.label)).toEqual(["#2 · same", "#1 · same"]);
});

test("keeps full multiline text while bounding previews and tracking images", () => {
  const text = "  line one\nline two " + "x".repeat(2000);
  const prompts = rewindPrompts([entry("a", [{ type: "text", text }, { type: "image", data: "binary" }]), entry("b", [{ type: "image" }])]);
  expect(prompts[1]!.text).toBe(text);
  expect(prompts[1]!.label.length).toBeLessThan(530);
  expect(prompts[0]!.label).toContain("Image prompt");
  expect(prompts.every((p) => p.images === 1)).toBe(true);
  expect(JSON.stringify(prompts)).not.toContain("binary");
});

test("ignores extension continuations, malformed entries, and assistant messages", () => {
  expect(rewindPrompts([null, {}, { type: "custom_message", content: "Continue goal" },
    { id: "a", type: "message", message: { role: "assistant", content: "hello" } }, entry("empty", " "),
  ])).toEqual([]);
  expect(rewindPrompts([entry("a", "\x1b]0;bad\x07\x1b[31mhello\x1b[0m")])[0]!.label).toBe("#1 · hello");
});
