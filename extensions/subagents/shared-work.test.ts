import { expect, test } from "bun:test";
import { SharedWork } from "./shared-work.ts";

test("shares one operation while callers cancel independently", async () => {
  const work = new SharedWork<string>();
  const gate = deferred<string>();
  let starts = 0;
  let sharedAborted = false;
  const start = (signal: AbortSignal) => {
    starts++;
    signal.addEventListener("abort", () => { sharedAborted = true; });
    return gate.promise;
  };
  const firstAbort = new AbortController();
  const first = work.acquire("leaf", firstAbort.signal, start);
  const second = work.acquire("leaf", undefined, start);
  firstAbort.abort();
  await expect(first).rejects.toThrow("aborted");
  expect(sharedAborted).toBe(false);
  gate.resolve("summary");
  expect(await second).toBe("summary");
  expect(starts).toBe(1);
  expect(await work.acquire("leaf", undefined, start)).toBe("summary");
  expect(starts).toBe(1);
});

test("aborts unfinished shared work when every consumer leaves", async () => {
  const work = new SharedWork<string>();
  const first = new AbortController();
  const second = new AbortController();
  let aborts = 0;
  const start = (signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      aborts++;
      reject(new Error("shared aborted"));
    }, { once: true });
  });
  const one = work.acquire("leaf", first.signal, start);
  const two = work.acquire("leaf", second.signal, start);
  first.abort();
  second.abort();
  await Promise.allSettled([one, two]);
  await Promise.resolve();
  expect(aborts).toBe(1);
});

test("retries a failed shared operation", async () => {
  const work = new SharedWork<string>();
  let attempts = 0;
  const start = async () => {
    attempts++;
    if (attempts === 1) throw new Error("temporary failure");
    return "recovered";
  };
  await expect(work.acquire("leaf", undefined, start)).rejects.toThrow("temporary failure");
  expect(await work.acquire("leaf", undefined, start)).toBe("recovered");
  expect(attempts).toBe(2);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
