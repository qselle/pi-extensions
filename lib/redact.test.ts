import { expect, test } from "bun:test";
import { StreamRedactor, redactText, redactValue } from "./redact.ts";

test("regex metacharacters in secrets are matched literally", () => {
  expect(redactText("a.b a+b (x|y)", ["a+b", "(x|y)"])).toBe("a.b [redacted] [redacted]");
  expect(redactText("plain", [])).toBe("plain");
});

test("streams pass through untouched until a secret is known", () => {
  let values: string[] = [];
  const stream = new StreamRedactor(() => values);
  expect(stream.push("tok")).toBe("tok");
  values = ["token-value"];
  expect(stream.push("token-va")).toBe("");
  expect(stream.push("lue!", true)).toBe("[redacted]!");
});

test("redactValue rewrites nested strings and keeps unchanged values by identity", () => {
  const untouched = { content: [{ type: "text", text: "fine" }], count: 2 };
  expect(redactValue(untouched, ["secret"])).toBe(untouched);
  const result = redactValue({ list: ["my secret", 1], nested: { value: "secret" }, date: new Date(0) }, ["secret"]);
  expect(result).toEqual({ list: ["my [redacted]", 1], nested: { value: "[redacted]" }, date: new Date(0) });
});
