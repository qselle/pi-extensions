import { expect, test } from "bun:test";
import { findSecretHandles, handleSlug, SecretVault } from "./secrets.ts";

function vault(): SecretVault {
  let counter = 0;
  return new SecretVault(() => (++counter).toString(16).padStart(8, "0"));
}

test("issues readable per-question handles that never repeat", () => {
  const secrets = vault();
  const first = secrets.issue("api key", "s3cret");
  const second = secrets.issue("api key", "other");

  expect(first).toBe("[[secret:api-key#00000001]]");
  expect(second).toBe("[[secret:api-key#00000002]]");
  expect(secrets.has(first)).toBe(true);
  expect(secrets.size).toBe(2);
  expect(handleSlug("///")).toBe("secret");
});

test("reveals handles nested inside tool input containers", () => {
  const secrets = vault();
  const handle = secrets.issue("token", "abc123");
  const input = {
    command: `curl -H "Authorization: Bearer ${handle}" https://api.test`,
    args: [handle, { nested: [`prefix ${handle}`] }],
    count: 3,
  };

  const result = secrets.reveal(input);

  expect(result.unknown).toEqual([]);
  expect(result.revealed).toEqual([handle]);
  expect(input.command).toBe('curl -H "Authorization: Bearer abc123" https://api.test');
  expect(input.args[0]).toBe("abc123");
  expect(input.args[1]).toEqual({ nested: ["prefix abc123"] });
  expect(input.count).toBe(3);
});

test("reports unknown handles and leaves them untouched", () => {
  const secrets = vault();
  const known = secrets.issue("token", "abc123");
  const input = { text: `${known} and [[secret:token#deadbeef]]` };

  const result = secrets.reveal(input);

  expect(result.revealed).toEqual([known]);
  expect(result.unknown).toEqual(["[[secret:token#deadbeef]]"]);
  expect(input.text).toBe("abc123 and [[secret:token#deadbeef]]");
});

test("clearing the vault invalidates previously issued handles", () => {
  const secrets = vault();
  const handle = secrets.issue("token", "abc123");
  secrets.clear();

  const input = { text: handle };
  expect(secrets.reveal(input)).toEqual({ revealed: [], unknown: [handle] });
  expect(input.text).toBe(handle);
  expect(secrets.size).toBe(0);
});

test("finds handles without mutating the inspected value", () => {
  const secrets = vault();
  const handle = secrets.issue("token", "abc123");
  const input = { list: [handle, "plain"], text: `${handle} ${handle}` };

  expect([...findSecretHandles(input)]).toEqual([handle]);
  expect([...findSecretHandles({ text: "nothing here" })]).toEqual([]);
  expect(input.text).toBe(`${handle} ${handle}`);
});
