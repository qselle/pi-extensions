import { expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { normalizeQuestions } from "./model.ts";
import { QuestionPrompt, type QuestionPromptResult } from "./ui.ts";

initTheme("dark");

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
  strikethrough: (value: string) => value,
};

const keybindings = {
  matches(data: string, id: string) {
    const keys: Record<string, string[]> = {
      "tui.select.up": ["up"],
      "tui.select.down": ["down"],
      "tui.select.confirm": ["\r"],
      "tui.select.cancel": ["escape"],
    };
    return keys[id]?.includes(data) ?? false;
  },
};

function createPrompt(questionInput: any, done: (result: QuestionPromptResult) => void) {
  const [question] = normalizeQuestions([questionInput]);
  let renders = 0;
  const prompt = new QuestionPrompt(
    question,
    0,
    1,
    true,
    { requestRender: () => { renders++; } } as any,
    theme as any,
    keybindings as any,
    done,
  );
  prompt.focused = true;
  return { prompt, renders: () => renders };
}

test("renders a compact picker with freeform Other as the final choice", () => {
  const { prompt } = createPrompt({
    id: "color",
    question: "Which color should be used?",
    options: ["Red", "Blue"],
  }, () => undefined);
  // Render wide enough that hints don't wrap/truncate, and measure by code-point
  // count, so the checks are stable across runtimes' east-asian-width handling.
  const lines = prompt.render(120);
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const text = lines.map(strip).join("\n");

  expect(text).toContain("Question 1/1");
  expect(text.indexOf("1. Red")).toBeLessThan(text.indexOf("2. Blue"));
  expect(text.indexOf("2. Blue")).toBeLessThan(text.indexOf("3. Other"));
  expect(text).toContain("Other · type your answer");
  expect(text.replace(/\s+/g, " ")).toContain("first reply wins");
  expect(lines.every((line) => [...strip(line)].length <= 120)).toBe(true);
});

test("renders Markdown and shades every wrapped line of the selected choice", () => {
  const [question] = normalizeQuestions([{
    id: "scope",
    question: "Choose a **scope** for `src/app.ts`",
    options: ["A **complete** pass through all the source and configuration files"],
    allow_other: false,
  }]);
  const selectedColor = "\x1b[48;2;69;64;61m";
  const coloredTheme = {
    ...theme,
    bg: (color: string, value: string) => color === "selectedBg" ? `${selectedColor}${value}\x1b[49m` : value,
  };
  const prompt = new QuestionPrompt(question, 0, 1, false, { requestRender() {} } as any, coloredTheme as any, keybindings as any, () => undefined);
  const lines = prompt.render(36);
  const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

  expect(plain).toContain("Choose a scope for src/app.ts");
  expect(plain).toContain("complete");
  expect(plain).not.toContain("**complete**");
  expect(lines.filter((line) => line.includes(selectedColor)).length).toBeGreaterThan(1);
  expect(lines.every((line) => [...line.replace(/\x1b\[[0-9;]*m/g, "")].length <= 36)).toBe(true);
});

test("keeps the selected choice visible in long lists", () => {
  const { prompt } = createPrompt({
    id: "many",
    question: "Pick one",
    options: Array.from({ length: 8 }, (_, index) => `Option ${index + 1}`),
  }, () => undefined);
  for (let index = 0; index < 8; index++) prompt.handleInput("down");
  const text = prompt.render(40).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  expect(text).toContain("9. Other");
  expect(text).toContain("↑ 4 more");
  expect(text).not.toContain("1. Option 1");
});

test("selects an option or submits a freeform answer", () => {
  const results: QuestionPromptResult[] = [];
  const first = createPrompt({ id: "color", question: "Color?", options: ["Red", "Blue"] }, (value) => results.push(value));
  first.prompt.handleInput("down");
  first.prompt.handleInput("\r");
  expect(results).toEqual([{ status: "answered", answer: "Blue" }]);

  const custom = createPrompt({ id: "color", question: "Color?", options: ["Red", "Blue"] }, (value) => results.push(value));
  custom.prompt.handleInput("down");
  custom.prompt.handleInput("down");
  custom.prompt.handleInput("\r");
  for (const character of "Ocean green") custom.prompt.handleInput(character);
  custom.prompt.handleInput("\r");
  expect(results.at(-1)).toEqual({ status: "answered", answer: "Ocean green" });
  expect(custom.renders()).toBeGreaterThan(0);
});

test("masks secret freeform input and supports cancellation", () => {
  const results: QuestionPromptResult[] = [];
  const { prompt } = createPrompt({ id: "token", question: "Token?", secret: true }, (value) => results.push(value));
  prompt.handleInput("\r");
  for (const character of "actual-secret") prompt.handleInput(character);
  const rendered = prompt.render(50).join("\n");
  expect(rendered).not.toContain("actual-secret");
  expect(rendered).toContain("••••••");
  prompt.handleInput("escape");
  expect(results).toEqual([{ status: "cancelled" }]);
});
