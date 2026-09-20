import { expect, test } from "bun:test";
import { copyText } from "./clipboard.ts";

test("waits for Pi clipboard success and forwards the excerpt unchanged", async () => {
  const text = "Unicode 🌍\n$(literal text)";
  let finish!: () => void;
  let settled = false;
  const pending = copyText(text, async (received) => {
    expect(received).toBe(text);
    await new Promise<void>((resolve) => { finish = resolve; });
  }).then((result) => { settled = true; return result; });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  expect(await pending).toBe(true);
});

test("host clipboard failures allow the caller to use its editor fallback", async () => {
  expect(await copyText("excerpt", async () => { throw new Error("Clipboard unavailable"); })).toBe(false);
});
