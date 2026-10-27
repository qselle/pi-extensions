import { expect, test } from "bun:test";
import { registerProcessExitReaper } from "./process-exit-reaper.ts";

const registry = () => (globalThis as any)[Symbol.for("@qselle/pi-extensions.process-exit-reaper.v1")];

test("reloaded modules share one exit listener that runs every live reaper", async () => {
  const listeners = process.listenerCount("exit");
  const reloaded = await import(`./process-exit-reaper.ts?reload=${Date.now()}`);
  expect(process.listenerCount("exit")).toBe(listeners);
  // Never run reapers that other test files may have registered for live jobs.
  const others = new Map(registry().callbacks);
  registry().callbacks.clear();
  try {
    const calls: string[] = [];
    const failing = registerProcessExitReaper(() => { calls.push("failing"); throw new Error("boom"); });
    const removed = reloaded.registerProcessExitReaper(() => calls.push("removed"));
    const kept = reloaded.registerProcessExitReaper(() => calls.push("kept"));
    removed(); removed();
    registry().listener();
    expect(calls).toEqual(["failing", "kept"]);
    failing(); kept();
    expect(registry().callbacks.size).toBe(0);
  } finally { for (const [token, reap] of others) registry().callbacks.set(token, reap); }
});
