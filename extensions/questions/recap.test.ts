import { expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { QuestionnaireDetails } from "./model.ts";
import { QuestionRecap } from "./recap.ts";

initTheme("dark");
const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as Theme;
const plain = (rows: string[]) => rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const details: QuestionnaireDetails = {
  questions: [{ id: "scope", question: "Choose a **scope** for `src/app.ts`", options: ["**Minimal** change", "Complete pass"] }],
  answers: [{ id: "scope", question: "unused", answer: "**Minimal** change", source: "telegram" }],
  interrupted: false,
};

test("renders selected Markdown answers without repeating the complete choices", () => {
  const collapsed = plain(new QuestionRecap(details, false, theme).render(90));
  expect(collapsed).toContain("Questions · 1/1 answered");
  expect(collapsed).toContain("Choose a scope for src/app.ts");
  expect(collapsed).toContain("Minimal change");
  expect(collapsed).not.toContain("**");
  expect(collapsed).toContain("via Telegram");
  expect(collapsed).not.toContain("Complete pass");
  const expanded = plain(new QuestionRecap(details, true, theme).render(90));
  expect(expanded).toContain("✓ Minimal change");
  expect(expanded).toContain("Complete pass");
});

test("collapsed long answers stay bounded and expanded answers recover every line", () => {
  const long = { ...details, answers: [{ ...details.answers[0], answer: Array.from({ length: 30 }, (_, index) => `row ${index}`).join("\n\n") }] };
  const collapsed = new QuestionRecap(long, false, theme).render(50);
  expect(collapsed.length).toBeLessThanOrEqual(8);
  expect(plain(collapsed)).toContain("for full answers and choices");
  expect(plain(collapsed)).not.toContain("row 29");
  expect(plain(new QuestionRecap(long, true, theme).render(50))).toContain("row 29");
  for (const width of [0, 1, 2, 6, 12, 30, 60, 100]) {
    for (const expanded of [false, true]) {
      const rows = new QuestionRecap(long, expanded, theme).render(width);
      expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  }
});

test("secret values and options stay masked even in malformed legacy results", () => {
  for (const expanded of [false, true]) {
    const secret = new QuestionRecap({
      questions: [{ id: "token", question: "API token?", secret: true, options: ["raw-option-secret"] }],
      answers: [{ id: "token", question: "API token?", answer: "raw-answer-secret", provided: true, handle: "pi-secret://opaque" }],
      interrupted: false,
    }, expanded, theme);
    const text = plain(secret.render(90));
    expect(text).toContain("•••••• · secret provided");
    expect(text).not.toContain("raw-option-secret");
    expect(text).not.toContain("raw-answer-secret");
    expect(text.includes("pi-secret://opaque")).toBe(expanded);
  }
});

test("cancelled and unanswered questions remain explicit without invented answers", () => {
  const text = plain(new QuestionRecap({
    questions: [{ id: "one", question: "First?" }, { id: "two", question: "Second?" }],
    answers: [{ id: "one", question: "First?", cancelled: true }],
    interrupted: true,
  }, false, theme).render(80));
  expect(text).toContain("0/2 answered · interrupted");
  expect(text).toContain("Cancelled");
  expect(text).toContain("Unanswered");
});
