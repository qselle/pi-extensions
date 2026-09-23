import { expect, test } from "bun:test";
import theme from "./gruvbox-dark.json";

const REQUIRED_COLORS = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
  "thinkingText", "scrollbarTrack", "scrollbarThumb", "selectedBg", "searchMatchBg", "searchMatchText",
  "userMessageBg", "userMessageText", "customMessageBg", "customMessageText",
  "customMessageLabel", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading",
  "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr",
  "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
  "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
  "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
  "thinkingXhigh", "thinkingMax", "bashMode",
] as const;

test("defines every current Pi color token", () => {
  expect(theme.name).toBe("gruvbox-dark");
  for (const token of REQUIRED_COLORS) expect(theme.colors).toHaveProperty(token);
});

test("uses valid hex colors or declared palette variables", () => {
  for (const value of Object.values(theme.vars)) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
  const values = [...Object.values(theme.colors), ...Object.values(theme.export)];
  for (const value of values) {
    const valid = /^#[0-9a-f]{6}$/i.test(value) || Object.hasOwn(theme.vars, value);
    expect(valid).toBe(true);
  }
});

type Token = keyof typeof theme.colors;
function resolve(value: string): string {
  return value.startsWith("#") ? value : theme.vars[value as keyof typeof theme.vars];
}
function color(token: Token): string { return resolve(theme.colors[token]); }
function luminance(hex: string): number {
  const linear = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}
function contrast(first: string, second: string): number {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("thinking, code and message text remain readable on their intended surfaces", () => {
  expect(contrast(color("text"), theme.vars.bg0)).toBeGreaterThanOrEqual(10);
  expect(contrast(color("thinkingText"), theme.vars.bg0)).toBeGreaterThanOrEqual(8);
  expect(contrast(color("thinkingText"), theme.vars.bg0)).toBeLessThan(contrast(color("text"), theme.vars.bg0));
  expect(contrast(color("mdCodeBlock"), theme.vars.bg0)).toBeGreaterThanOrEqual(10);
  for (const [foreground, background] of [
    ["userMessageText", "userMessageBg"], ["customMessageText", "customMessageBg"],
    ["toolOutput", "toolPendingBg"], ["toolOutput", "toolSuccessBg"], ["toolOutput", "toolErrorBg"],
    ["text", "selectedBg"],
  ] as const) expect(contrast(color(foreground), color(background))).toBeGreaterThanOrEqual(7);
  expect(contrast(color("searchMatchText"), color("searchMatchBg"))).toBeGreaterThanOrEqual(4.5);
  expect(contrast(color("error"), color("toolErrorBg"))).toBeGreaterThanOrEqual(4);
});

test("structure and success panels stay quieter than content and attention states", () => {
  for (const token of ["border", "borderMuted", "mdCodeBlockBorder", "mdQuoteBorder", "mdHr"] as const) {
    expect(contrast(color(token), theme.vars.bg0)).toBeLessThan(contrast(color("muted"), theme.vars.bg0));
  }
  expect(contrast(color("toolSuccessBg"), theme.vars.bg0)).toBeLessThan(1.2);
  expect(contrast(color("toolPendingBg"), theme.vars.bg0)).toBeGreaterThan(1.2);
  expect(contrast(color("toolPendingBg"), theme.vars.bg0)).toBeLessThan(1.35);
  expect(contrast(color("toolPendingBg"), theme.vars.bg0)).toBeLessThan(contrast(color("userMessageBg"), theme.vars.bg0));
  expect(color("toolErrorBg")).not.toBe(color("toolSuccessBg"));
  expect(color("borderAccent")).not.toBe(color("border"));
});

test("user messages have a distinct warm panel and high-contrast text", () => {
  expect(contrast(color("userMessageBg"), theme.vars.bg0)).toBeGreaterThanOrEqual(1.6);
  // Many terminals use #2e2e2e rather than the ideal Gruvbox base.
  expect(contrast(color("userMessageBg"), "#2e2e2e")).toBeGreaterThanOrEqual(1.5);
  expect(contrast(color("userMessageText"), color("userMessageBg"))).toBeGreaterThanOrEqual(7);
  expect(color("userMessageBg")).not.toBe(color("customMessageBg"));
  expect(color("userMessageBg")).not.toBe(color("toolPendingBg"));
});

test("syntax roles retain distinct readable hues and reasoning levels remain distinguishable", () => {
  const syntax: Token[] = ["syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator"];
  expect(new Set(syntax.map(color)).size).toBe(syntax.length);
  for (const token of [...syntax, "syntaxComment", "syntaxPunctuation"] as Token[]) {
    expect(contrast(color(token), theme.vars.bg0)).toBeGreaterThanOrEqual(4);
  }
  const thinking: Token[] = ["thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax"];
  expect(new Set(thinking.map(color)).size).toBe(thinking.length);
});
