import { expect, test } from "bun:test";
import { Type } from "typebox";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { commandPurpose, commandPurposeParameter, COMMAND_PURPOSE_GUIDELINE } from "./tool-purpose.ts";

test("command purpose is optional metadata without a validation length failure", () => {
  const schema = Type.Object({ command: Type.String(), purpose: commandPurposeParameter });
  expect(schema.required).toEqual(["command"]);
  expect(schema.properties.purpose.type).toBe("string");
  expect("maxLength" in schema.properties.purpose).toBe(false);
  expect(COMMAND_PURPOSE_GUIDELINE).toContain("user-facing");
});

test("Pi accepts omitted and provider-null purposes without changing the command", () => {
  const tool = { name: "bash", description: "Execute a command", parameters: Type.Object({ purpose: commandPurposeParameter, command: Type.String() }) };
  const calls: Array<Record<string, string | null>> = [{ command: "printf ok" }, { purpose: null, command: "printf ok" }];
  for (const arguments_ of calls) {
    expect(validateToolArguments(tool, { type: "toolCall", id: "purpose-validation", name: "bash", arguments: arguments_ })).toEqual({ command: "printf ok" });
  }
  const long = "x".repeat(200);
  expect(validateToolArguments(tool, { type: "toolCall", id: "purpose-validation", name: "bash", arguments: { purpose: long, command: "printf ok" } })).toEqual({ purpose: long, command: "printf ok" });
});

test("purpose accepts only nonempty text and flattens display whitespace", () => {
  for (const value of [undefined, null, false, 1, {}, [], "", " \n\t\r "]) expect(commandPurpose(value)).toBe("");
  expect(commandPurpose("  Check\t focused\r\nrenderer\u2028tests ")).toBe("Check focused renderer tests");
  expect(commandPurpose("Check emoji 🌍 and 中文")).toBe("Check emoji 🌍 and 中文");
});

test("purpose strips terminal sequences, clipboard links, and bidi controls", () => {
  const value = "\x1b[31mCheck\x1b[0m \x1b]52;c;clipboard\x07\x1b]8;;https://example.com\x1b\\tests\x1b]8;;\x1b\\\x00\x08\u061c\u200e\u200f\u202e\u202c\u2066\u2069";
  expect(commandPurpose(value)).toBe("Check tests");
  expect(commandPurpose("\x1b]52;c;unfinished")).toBe("");
});

test("purpose bounds both source work and displayed Unicode without broken surrogates", () => {
  expect(commandPurpose("x".repeat(160))).toBe("x".repeat(160));
  expect(commandPurpose("x".repeat(161))).toBe("x".repeat(159) + "…");
  expect(commandPurpose("🌍".repeat(200))).toBe("🌍".repeat(159) + "…");
  expect(commandPurpose("Check tests " + " ".repeat(4096) + "unread tail")).toBe("Check tests…");
  expect(commandPurpose("x".repeat(4095) + "🌍")).toBe("x".repeat(159) + "…");
});
