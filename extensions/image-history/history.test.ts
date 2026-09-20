import { expect, test } from "bun:test";
import { referenceOlderImages, restoreEnabled, retrieveImage, STATE_TYPE } from "./history.ts";
const image = { type: "image" as const, mimeType: "image/png", data: "base64-image" };
const old = { role: "user", content: [image, { type: "text", text: "Compare this" }] };
const entries = [{ type: "message", id: "entry", message: old }];
test("defers older images while preserving the entire current turn and source history", () => {
  const current = { role: "user", content: [image, image] };
  const tool = { role: "toolResult", content: [image] };
  const result = referenceOlderImages([old, current, tool], entries);
  expect(result.replaced).toBe(1);
  expect(JSON.stringify(result.messages[0])).toContain('entry:0');
  expect(result.messages[1]).toBe(current);
  expect(result.messages[2]).toBe(tool);
  expect(old.content[0]).toBe(image);
  expect(retrieveImage(entries, "entry:0")).toEqual(image);
});
test("keeps unrecoverable images, no-user context and non-image parts unchanged", () => {
  const unknown = { ...image, data: "missing" };
  const messages = [{ role: "user", content: [unknown] }, { role: "user", content: "Now" }];
  expect(referenceOlderImages(messages, entries).messages).toEqual(messages);
  expect(referenceOlderImages([{ role: "toolResult", content: [image] }], entries).replaced).toBe(0);
  expect(retrieveImage(entries, "entry:-1")).toBeUndefined();
  expect(retrieveImage(entries, "entry:1")).toBeUndefined();
  expect(retrieveImage([], "entry:0")).toBeUndefined();
});
test("opt-in state follows branch append order and rejects malformed state", () => {
  const on = { type: "custom", customType: STATE_TYPE, data: { version: 1, enabled: true } };
  expect(restoreEnabled([])).toBe(false);
  expect(restoreEnabled([on])).toBe(true);
  expect(restoreEnabled([on, { ...on, data: { version: 1, enabled: false } }])).toBe(false);
  expect(restoreEnabled([{ ...on, data: { version: 99, enabled: true } }])).toBe(false);
});
