import { expect, test } from "bun:test";
import { normalizeQuestions, parseReplyText, publicQuestions } from "./model.ts";

test("normalizes the compatible questionnaire schema and keeps freeform last by default", () => {
  const questions = normalizeQuestions([
    { id: "scope", question: " Pick a scope ", options: ["Small", "Large"] },
    { id: "reason", question: "Why?", allow_other: false },
  ]);

  expect(questions).toEqual([
    { id: "scope", question: "Pick a scope", options: ["Small", "Large"], allowOther: true, secret: false },
    { id: "reason", question: "Why?", options: [], allowOther: true, secret: false },
  ]);
  expect(publicQuestions(questions)).toEqual([
    { id: "scope", question: "Pick a scope", options: ["Small", "Large"] },
    { id: "reason", question: "Why?" },
  ]);
});

test("parses Telegram option numbers, labels, freeform text, and cancellation", () => {
  const [question] = normalizeQuestions([
    { id: "color", question: "Color?", options: ["Red", "Blue"] },
  ]);
  expect(parseReplyText(question, "2")).toBe("Blue");
  expect(parseReplyText(question, "1. Red please")).toBe("Red");
  expect(parseReplyText(question, "blue")).toBe("Blue");
  expect(parseReplyText(question, "Something else")).toBe("Something else");
  expect(parseReplyText(question, "/cancel")).toBe("cancel");

  const [closed] = normalizeQuestions([
    { id: "color", question: "Color?", options: ["Red", "Blue"], allow_other: false },
  ]);
  expect(parseReplyText(closed, "Something else")).toBeUndefined();
});

test("rejects malformed, duplicated, and oversized questionnaires", () => {
  expect(() => normalizeQuestions([])).toThrow("at least one");
  expect(() => normalizeQuestions([
    { id: "same", question: "One?" },
    { id: "same", question: "Two?" },
  ])).toThrow("duplicated");
  expect(() => normalizeQuestions([
    { id: "many", question: "Too many?", options: Array.from({ length: 9 }, (_, index) => String(index)) },
  ])).toThrow("at most 8");
});
