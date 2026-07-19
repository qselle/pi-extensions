import { expect, test } from "bun:test";
import { firstReplyWins, type ReplySource } from "./race.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("the first answer wins and aborts the losing source", async () => {
  const remote = deferred<{ status: "answered"; answer: string }>();
  let terminalAborted = false;
  const sources: ReplySource[] = [
    {
      name: "terminal",
      run: (signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          terminalAborted = true;
          resolve({ status: "unavailable" });
        }, { once: true });
      }),
    },
    { name: "telegram", run: () => remote.promise },
  ];

  const resultPromise = firstReplyWins(sources);
  remote.resolve({ status: "answered", answer: "Telegram answer" });
  expect(await resultPromise).toEqual({ status: "answered", answer: "Telegram answer", source: "telegram" });
  expect(terminalAborted).toBe(true);
});

test("a failed source leaves the other source available", async () => {
  const terminal = deferred<{ status: "answered"; answer: string }>();
  const errors: string[] = [];
  const resultPromise = firstReplyWins([
    { name: "telegram", run: async () => { throw new Error("offline"); } },
    { name: "terminal", run: () => terminal.promise },
  ], {
    onSourceError: (source) => errors.push(source),
  });

  await Bun.sleep(0);
  terminal.resolve({ status: "answered", answer: "Local answer" });
  expect(await resultPromise).toEqual({ status: "answered", answer: "Local answer", source: "terminal" });
  expect(errors).toEqual(["telegram"]);
});

test("cancellation and an external abort stop every source", async () => {
  const cancelled = await firstReplyWins([
    { name: "terminal", run: async () => ({ status: "cancelled" }) },
  ]);
  expect(cancelled).toEqual({ status: "cancelled", source: "terminal" });

  const controller = new AbortController();
  let sourceAborted = false;
  const pending = firstReplyWins([
    {
      name: "telegram",
      run: (signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          sourceAborted = true;
          resolve({ status: "unavailable" });
        }, { once: true });
      }),
    },
  ], { signal: controller.signal });
  controller.abort();
  expect(await pending).toEqual({ status: "cancelled" });
  expect(sourceAborted).toBe(true);
});
