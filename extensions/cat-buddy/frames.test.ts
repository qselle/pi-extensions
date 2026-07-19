import { expect, test } from "bun:test";
import {
  CAT_FRAME_DURATION_MS,
  CAT_FRAME_SEQUENCE,
  CAT_HEIGHT,
  CAT_POSES,
  CAT_WIDTH,
  getCatPose,
} from "./frames.ts";

test("preserves the source animation timing and frame count", () => {
  expect(CAT_FRAME_DURATION_MS).toBe(160);
  expect(CAT_FRAME_SEQUENCE).toHaveLength(27);
  expect(getCatPose(CAT_FRAME_SEQUENCE.length)).toEqual(getCatPose(0));
});

test("every compact pose fits the input-bar overlay", () => {
  for (const pose of CAT_POSES) {
    expect(pose).toHaveLength(CAT_HEIGHT);
    for (const line of pose) {
      expect(line).toMatch(/^[ \u2800-\u28ff]*$/u);
      expect(line.length).toBeLessThanOrEqual(CAT_WIDTH);
    }
  }
});

test("the neutral frame remains stable at the loop boundary", () => {
  expect(getCatPose(-1)).toEqual(getCatPose(CAT_FRAME_SEQUENCE.length - 1));
  expect(getCatPose(0)).toEqual(getCatPose(CAT_FRAME_SEQUENCE.length));
});
