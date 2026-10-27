import { expect, test } from "bun:test";
import { DEFERRAL_BATCH, referenceOlderImages, restoreEnabled, retrieveImage, STATE_TYPE } from "./history.ts";
const image = { type: "image" as const, mimeType: "image/png", data: "base64-image" };
const old = { role: "user", content: [image, { type: "text", text: "Compare this" }] };
const entries = [{ type: "message", id: "entry", message: old }];
test("defers older images while preserving the entire current turn and source history", () => {
  const current = { role: "user", content: [image, image] };
  const tool = { role: "toolResult", content: [image] };
  const result = referenceOlderImages([old, current, tool], entries, 1);
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
  expect(referenceOlderImages(messages, entries, 1).messages).toEqual(messages);
  expect(referenceOlderImages([{ role: "toolResult", content: [image] }], entries, 1).replaced).toBe(0);
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

test("defers images in batches so each request extends the previous request's prefix", () => {
  const turns = Array.from({ length: 20 }, (_, index) => ({ role: "user", content: [{ type: "image" as const, mimeType: "image/png", data: `image-${index}` }, { type: "text", text: `turn ${index}` }] }));
  const branch = turns.map((message, index) => ({ type: "message", id: `turn-${index}`, message }));
  const requests = turns.map((_, index) => referenceOlderImages(turns.slice(0, index + 1), branch).messages);
  const rewrites: number[] = [];
  for (let index = 1; index < requests.length; index++) {
    const previous = requests[index - 1]!;
    if (JSON.stringify(requests[index]!.slice(0, previous.length)) !== JSON.stringify(previous)) rewrites.push(index);
  }
  // Only the turns that complete a batch rewrite earlier messages.
  expect(rewrites).toEqual([DEFERRAL_BATCH, DEFERRAL_BATCH * 2]);
  const last = requests.at(-1)!;
  expect(JSON.stringify(last.slice(0, DEFERRAL_BATCH * 2))).not.toContain("image-");
  expect(JSON.stringify(last.slice(DEFERRAL_BATCH * 2))).toContain("image-16");
});
