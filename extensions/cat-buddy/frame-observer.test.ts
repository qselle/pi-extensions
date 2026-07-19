import { expect, test } from "bun:test";
import type { TUI } from "@earendil-works/pi-tui";
import { observeRenderedFrames } from "./frame-observer.ts";

type Compositor = (frame: string[], columns: number, rows: number) => string[];

function mockTui() {
  const original: Compositor = (frame) => [...frame, "composited"];
  const runtime = { compositeOverlays: original };
  return { original, runtime, tui: runtime as unknown as TUI };
}

test("shares one compositor wrapper and restores it after the last observer", () => {
  const { original, runtime, tui } = mockTui();
  const calls: string[] = [];
  const stopFirst = observeRenderedFrames(tui, (frame) => calls.push(`first:${frame[0]}`));
  const wrapped = runtime.compositeOverlays;
  const stopSecond = observeRenderedFrames(tui, (frame) => calls.push(`second:${frame[0]}`));

  expect(stopFirst).toBeDefined();
  expect(stopSecond).toBeDefined();
  expect(runtime.compositeOverlays).toBe(wrapped);
  expect(runtime.compositeOverlays(["frame"], 80, 24)).toEqual(["frame", "composited"]);
  expect(calls).toEqual(["first:frame", "second:frame"]);

  stopFirst!();
  expect(runtime.compositeOverlays).toBe(wrapped);
  stopSecond!();
  expect(runtime.compositeOverlays).toBe(original);
});

test("removes a failing observer without breaking rendering", () => {
  const { runtime, tui } = mockTui();
  let calls = 0;
  const stop = observeRenderedFrames(tui, () => {
    calls += 1;
    throw new Error("boom");
  });

  expect(runtime.compositeOverlays([], 80, 24)).toEqual(["composited"]);
  expect(runtime.compositeOverlays([], 80, 24)).toEqual(["composited"]);
  expect(calls).toBe(1);
  stop?.();
});

test("fails closed when the compositor is unavailable", () => {
  expect(observeRenderedFrames({} as TUI, () => {})).toBeUndefined();
});
