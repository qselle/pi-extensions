import { expect, test } from "bun:test";
import { decodeJournal, emptyJournal, historyMatches, JOURNAL_ENTRY, restoreJournal, updateNote } from "./state.ts";

test("notes enforce key/count/size bounds and redact known secrets", () => {
  const next = updateNote(emptyJournal(), "objective", "finish secret", ["secret"]);
  expect(next.notes.objective).toBe("finish [redacted]");
  expect(emptyJournal().notes).toEqual({});
  expect(() => updateNote(next, "__proto__", "bad")).toThrow();
  expect(() => updateNote(next, "x", "a".repeat(4001))).toThrow();
  let full = emptyJournal();
  for (let i = 0; i < 4; i++) full = updateNote(full, `note-${i}`, "x".repeat(4000));
  expect(() => updateNote(full, "extra", "x")).toThrow();
  expect(Object.keys(updateNote(full, "note-0", null).notes)).toHaveLength(3);
  expect(decodeJournal({ version: 2, enabled: true, notes: {} })).toBeUndefined();
});
test("restores only valid branch-local state", () => {
  const saved = { ...updateNote(emptyJournal(), "task", "continue"), enabled: true };
  expect(restoreJournal([{ type: "custom", customType: JOURNAL_ENTRY, data: saved }, { type: "custom", customType: JOURNAL_ENTRY, data: null }])).toEqual(saved);
  expect(restoreJournal([]).enabled).toBe(false);
});
const message = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: text } });
test("search matches full older content and returns bounded excerpts near the match", () => {
  const entries = [message("older", "a".repeat(10000) + "NEEDLE" + "z".repeat(5000)), message("newer", "needle")];
  const first = historyMatches(entries, "needle", 1);
  expect(first.matches[0]?.id).toBe("newer");
  const next = historyMatches(entries, "needle", 1, first.nextBefore);
  expect(next.matches[0]?.id).toBe("older");
  expect(next.matches[0]?.excerpt).toContain("NEEDLE");
  expect(next.matches[0]!.excerpt.length).toBeLessThanOrEqual(2000);
  expect(next.nextBefore).toBeUndefined();
  expect(() => historyMatches(entries, "", 10, "foreign")).toThrow();
});

test("history continuation requires an older matching entry, not just older rows", () => {
  const entries = [message("old", "unrelated"), message("new", "needle")];
  expect(historyMatches(entries, "needle", 1).nextBefore).toBeUndefined();
  expect(historyMatches(entries, "", 1).nextBefore).toBe("new");
  expect(historyMatches(entries, "", 1, "new").nextBefore).toBeUndefined();
});
test("history excludes hidden context, reasoning and image payloads and bounds total output", () => {
  const entries: any[] = [ { type: "custom_message", id: "hidden", display: false, content: "private" }, { type: "message", id: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "image", data: "private" }, { type: "text", text: "public secret" }] } } ];
  expect(historyMatches(entries, "private").matches).toEqual([]);
  expect(historyMatches(entries, "public", 10, undefined, ["secret"]).matches[0]?.excerpt).toBe("public [redacted]");
  const large = historyMatches(Array.from({ length: 20 }, (_, i) => message(String(i), "界😀".repeat(2000))), "", 20);
  expect(large.matches.reduce((sum, value) => sum + value.excerpt.length, 0)).toBeLessThanOrEqual(12000);
  expect(large.matches.every((value) => !/[\ud800-\udbff]…$/.test(value.excerpt))).toBe(true);
});
