import { beforeAll, expect, test } from "bun:test";
import {
  initTheme,
  Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  COLLAPSED_BODY_ROWS,
  EXPANDED_BODY_ROWS,
  FILE_CARD_MAX_WIDTH,
  FileMutationCard,
} from "./ui.ts";

const FG_TOKENS: ThemeColor[] = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
  "thinkingText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
  "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
  "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax",
  "bashMode",
];

const fgColors = Object.fromEntries(FG_TOKENS.map((token, index) => [token, index % 2 === 0 ? "#d0d0d0" : "#80a0ff"])) as Record<ThemeColor, string>;
const bgColors = {
  selectedBg: "#202020",
  userMessageBg: "#202020",
  customMessageBg: "#202020",
  toolPendingBg: "#202020",
  toolSuccessBg: "#203020",
  toolErrorBg: "#302020",
};
const theme = new Theme(fgColors, bgColors, "truecolor");
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/gu;
const plain = (value: string) => value.replace(ANSI, "");

beforeAll(() => initTheme("dark", false));

test("renders a bounded self-contained syntax-highlighted edit card", () => {
  const card = new FileMutationCard("edit", theme);
  card.setCall({
    path: "src/features/example.ts",
    edits: [{ oldText: "const answer = 41;", newText: "const answer = 42;" }],
  }, false, theme);
  const diff = [
    " 1 export function answer() {",
    "-2   const answer = 41;",
    "+2   const answer = 42;",
    ...Array.from({ length: 20 }, (_, index) => ` ${index + 3}   const context${index} = ${index};`),
    "-23   return 41;",
    "+23   return 42;",
    " 24 }",
  ].join("\n");
  card.setResult({ content: [{ type: "text", text: "ok" }], details: { diff } }, false, false, theme);

  const lines = card.render(72);
  const output = lines.map(plain).join("\n");

  expect(lines.length).toBeLessThanOrEqual(COLLAPSED_BODY_ROWS + 2);
  expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
  expect(output).toContain("╭─");
  expect(output).toContain("EDIT src/features/example.ts +2 -2");
  expect(output).toContain("rows hidden");
  expect(output).toContain("return 42");
  expect(output).toContain("TypeScript");
  expect(lines.join("\n")).toContain("\x1b[");
});

test("keeps expanded previews bounded and responsive on narrow and wide terminals", () => {
  const card = new FileMutationCard("write", theme);
  const content = Array.from({ length: 80 }, (_, index) => `export const value${index}: number = ${index};`).join("\n");
  card.setCall({ path: "generated/values.ts", content }, true, theme);
  card.setResult({ content: [{ type: "text", text: "written" }] }, false, true, theme);

  const expanded = card.render(160);
  expect(expanded.length).toBeLessThanOrEqual(EXPANDED_BODY_ROWS + 2);
  expect(expanded.every((line) => visibleWidth(line) <= FILE_CARD_MAX_WIDTH)).toBe(true);
  expect(plain(expanded.join("\n"))).toContain("bounded preview");
  expect(plain(expanded.join("\n"))).toContain("80 lines");

  card.invalidate();
  const narrow = card.render(28);
  expect(narrow.every((line) => visibleWidth(line) <= 28)).toBe(true);
  expect(plain(narrow[0] ?? "")).toStartWith("╭─");
  expect(plain(narrow.at(-1) ?? "")).toStartWith("╰─");
});

test("shows language-aware write previews and contained failures", () => {
  const write = new FileMutationCard("write", theme);
  write.setCall({ path: "scripts/hello.py", content: "def hello(name):\n    return f'hello {name}'\n" }, false, theme);
  write.setResult({ content: [{ type: "text", text: "ok" }] }, false, false, theme);
  const written = write.render(64).map(plain).join("\n");
  expect(written).toContain("WRITE scripts/hello.py");
  expect(written).toContain("Python");
  expect(written).toContain("def hello(name):");
  expect(written).toContain("written");

  const failed = new FileMutationCard("edit", theme);
  failed.setCall({ path: "src/missing.ts", edits: [{ oldText: "x", newText: "y" }] }, false, theme);
  failed.setResult({ content: [{ type: "text", text: "Could not find the exact text\nTry a more specific match" }] }, true, false, theme);
  const errorLines = failed.render(54);
  const error = errorLines.map(plain).join("\n");
  expect(error).toContain("✕ EDIT src/missing.ts");
  expect(error).toContain("Could not find the exact text");
  expect(error).toContain("failed");
  expect(errorLines.length).toBeLessThanOrEqual(COLLAPSED_BODY_ROWS + 2);
});
