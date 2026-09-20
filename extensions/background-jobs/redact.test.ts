import { expect, test } from "bun:test";
import { StreamRedactor, redactText } from "../../lib/redact.ts";
import { knownSecretValues, registerSecretVault, SecretVault } from "../questions/secrets.ts";

test("redaction waits for split prefixes and chooses the longest overlapping secret", () => {
  const stream = new StreamRedactor(() => ["abc", "abcdef"]);
  expect(stream.push("before abc")).toBe("before ");
  expect(stream.push("def after ab")).toBe("[redacted] after ");
  expect(stream.push("c end", true)).toBe("[redacted] end");
  expect(redactText("abcd", ["abc"])).toBe("[redacted]d");
});

test("new secrets are recognized and previously known values survive source cleanup", () => {
  let values = ["first-secret"];
  const stream = new StreamRedactor(() => values);
  expect(stream.push("first-")).toBe("");
  values = ["second-secret"];
  expect(stream.push("secret second-")).toBe("[redacted] ");
  values = [];
  expect(stream.push("secret", true)).toBe("[redacted]");
});

test("only registered questionnaire vaults contribute values, never opaque handles", () => {
  const vault = new SecretVault();
  const handle = vault.issue("test", "fixture-private-value");
  const unregister = registerSecretVault(vault);
  try {
    expect(knownSecretValues()).toContain("fixture-private-value");
    expect(knownSecretValues()).not.toContain(handle);
    vault.clear();
    expect(knownSecretValues()).not.toContain("fixture-private-value");
  } finally { unregister(); }
});
