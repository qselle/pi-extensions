import { describe, expect, test } from "bun:test";
import {
  MAX_LOOP_INTERVAL_MS,
  MIN_LOOP_INTERVAL_MS,
  formatDuration,
  parseDuration,
  parseLoopCommand,
} from "./interval.ts";

describe("loop interval parsing", () => {
  test("parses bounded duration tokens", () => {
    expect(parseDuration("60s")).toBe(MIN_LOOP_INTERVAL_MS);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h")).toBe(MAX_LOOP_INTERVAL_MS);
    expect(parseDuration("30s")).toBeUndefined();
    expect(parseDuration("1.5h")).toBeUndefined();
    expect(parseDuration("1d")).toBeUndefined();
    expect(parseDuration("2d")).toBeUndefined();
  });

  test("supports leading and natural trailing intervals", () => {
    expect(parseLoopCommand("5m check the deploy")).toEqual({
      prompt: "check the deploy",
      intervalMs: 300_000,
    });
    expect(parseLoopCommand("check the deploy every 15m")).toEqual({
      prompt: "check the deploy",
      intervalMs: 900_000,
    });
  });

  test("uses dynamic pacing when no interval is present", () => {
    expect(parseLoopCommand('"watch CI until it is green"')).toEqual({
      prompt: "watch CI until it is green",
      intervalMs: null,
    });
  });

  test("rejects duration-shaped tokens outside the supported bounds", () => {
    expect(parseLoopCommand("30s check the deploy")).toBeUndefined();
    expect(parseLoopCommand("2h")).toBeUndefined();
    expect(parseLoopCommand("check the deploy every 2d")).toBeUndefined();
  });

  test("formats approximate countdowns", () => {
    expect(formatDuration(1)).toBe("1s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(3_700_000)).toBe("2h");
  });
});
