import { expect, test } from "bun:test";
import {
  containsTerminalText,
  findEditorTopBorder,
  isEditorBorder,
  removeTerminalControls,
  rightEdgeRange,
} from "./layout.ts";

const WIDTH = 40;
const BORDER = "─".repeat(WIDTH);

test("recognizes plain, colored, and queued-message editor borders", () => {
  expect(isEditorBorder(BORDER, WIDTH)).toBe(true);
  expect(isEditorBorder(`\u001b[31m${BORDER}\u001b[0m`, WIDTH)).toBe(true);
  const queuedPrefix = "─── ↑ 2 more ";
  expect(isEditorBorder(queuedPrefix + "─".repeat(WIDTH - queuedPrefix.length), WIDTH)).toBe(true);
  expect(isEditorBorder("short", WIDTH)).toBe(false);
});

test("locates the editor top border from the visible frame", () => {
  const frame = ["transcript", BORDER, "", "prompt", BORDER, "footer"];
  expect(findEditorTopBorder(frame, 0, WIDTH, 24)).toBe(1);
});

test("rejects border pairs too tall to be the editor", () => {
  const frame = [BORDER, ...Array(20).fill("content"), BORDER];
  expect(findEditorTopBorder(frame, 0, WIDTH, 24)).toBeUndefined();
});

test("detects text after removing terminal control sequences", () => {
  expect(removeTerminalControls("\u001b[31mhello\u001b[0m")).toBe("hello");
  expect(containsTerminalText("\u001b[31m   \u001b[0m")).toBe(false);
  expect(containsTerminalText("\u001b[31m cat \u001b[0m")).toBe(true);
});

test("computes a clamped right-edge collision range", () => {
  expect(rightEdgeRange(80, 12, 2)).toEqual({ left: 66, right: 78 });
  expect(rightEdgeRange(10, 12, 2)).toEqual({ left: 0, right: 12 });
});
