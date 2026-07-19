import { expect, mock, test } from "bun:test";
import type { FileChange } from "./changes.ts";

const visibleWidth = (value: string) => value.length;
class MockInput {
  private value = "";
  focused = false;
  getValue() { return this.value; }
  setValue(value: string) { this.value = value; }
  handleInput(data: string) {
    if (data === "backspace") this.value = this.value.slice(0, -1);
    else if (data === "ctrl+u") this.value = "";
    else if (data.length === 1 && data >= " ") this.value += data;
  }
  render(width: number) { return [this.value.slice(0, width)]; }
  invalidate() {}
}

mock.module("@earendil-works/pi-tui", () => ({
  Input: MockInput,
  Text: class Text {
    constructor(public text: string) {}
    render() { return [this.text]; }
    invalidate() {}
  },
  Key: {
    ctrl: (key: string) => `ctrl+${key}`,
    escape: "escape",
    enter: "enter",
    up: "up",
    down: "down",
  },
  matchesKey: (data: string, key: string) => data === key || (data === "\x12" && key === "ctrl+r"),
  sliceByColumn: (value: string, start: number, width: number) => value.slice(start, start + width),
  truncateToWidth: (value: string, width: number) => value.slice(0, width),
  visibleWidth,
  wrapTextWithAnsi: (value: string, width: number) => value.length <= width ? [value] : [value.slice(0, width), value.slice(width)],
}));

const { compactFilePath, fileChangesTitle, renderFileChangesBody } = await import("./ui.ts");

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
  strikethrough: (value: string) => value,
} as any;

test("compacts long paths while retaining the filename", () => {
  const path = "packages/client/src/features/settings/AccountPanel.test.ts";
  const compact = compactFilePath(path, 24);
  expect(visibleWidth(compact)).toBeLessThanOrEqual(24);
  expect(compact).toEndWith("AccountPanel.test.ts");
  expect(compact).toContain("…");
});

test("renders aligned file counts, overflow, and totals within card bounds", () => {
  const files: FileChange[] = Array.from({ length: 11 }, (_, index) => ({
    path: `src/features/very-long-section/component-${index}.ts`,
    kind: index === 0 ? "created" : "modified",
    additions: index + 1,
    removals: index % 2,
  }));
  const display = { phase: "live" as const, files };
  const lines = renderFileChangesBody(display, 42, 6, theme);
  const output = lines.join("\n");

  expect(fileChangesTitle(display, theme)).toContain("Changed files");
  expect(fileChangesTitle(display, theme)).toContain("live");
  expect(lines).toHaveLength(6);
  expect(output).toContain("more");
  expect(output).toContain("11 files");
  expect(output).toContain("+66");
  expect(output).toContain("-5");
  expect(lines.every((line) => visibleWidth(line) <= 42)).toBe(true);
});

test("uses distinct created and modified markers and omits zero counters", () => {
  const lines = renderFileChangesBody({
    phase: "last",
    files: [
      { path: "created.ts", kind: "created", additions: 3, removals: 0 },
      { path: "modified.ts", kind: "modified", additions: 0, removals: 2 },
    ],
  }, 36, 5, theme);

  expect(lines[0]).toStartWith("+ ");
  expect(lines[0]).toContain("+3");
  expect(lines[0]).not.toContain("-0");
  expect(lines[1]).toStartWith("~ ");
  expect(lines[1]).toContain("-2");
  expect(lines[1]).not.toContain("+0");
});
