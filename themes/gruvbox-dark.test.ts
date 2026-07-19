import { expect, test } from "bun:test";
import theme from "./gruvbox-dark.json";

const REQUIRED_COLORS = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
  "thinkingText", "selectedBg", "userMessageBg", "userMessageText", "customMessageBg", "customMessageText",
  "customMessageLabel", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading",
  "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr",
  "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
  "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
  "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
  "thinkingXhigh", "bashMode",
] as const;

test("defines every required Pi color token", () => {
  expect(theme.name).toBe("gruvbox-dark");
  for (const token of REQUIRED_COLORS) expect(theme.colors).toHaveProperty(token);
});

test("uses valid hex colors or declared palette variables", () => {
  const values = [...Object.values(theme.colors), ...Object.values(theme.export)];
  for (const value of values) {
    const valid = /^#[0-9a-f]{6}$/i.test(value) || Object.hasOwn(theme.vars, value);
    expect(valid).toBe(true);
  }
});
