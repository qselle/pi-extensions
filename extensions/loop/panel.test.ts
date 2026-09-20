import { expect, test } from "bun:test";
import { createLoop, pauseLoop, stopLoop } from "./loop.ts";
import { loopBlocks } from "./panel.ts";

test("loop snapshots retain full prompts, budgets and reasons without mutating jobs", () => {
  const prompt = "Long instruction\n".repeat(100) + "unique-tail";
  const active = { ...createLoop(prompt, 300_000, 1_000, "active"), iterations: 3, nextRunAt: 301_000 };
  const paused = { ...pauseLoop(createLoop("model task", null, 2_000, "paused"), "Interrupted"), lastScheduleReason: "Waiting for checks", fallbackWakeups: 1 };
  const stopped = stopLoop(createLoop("old task", 60_000, 3_000, "stopped"), "stopped", "Done");
  const jobs = [stopped, paused, active];
  const before = JSON.stringify(jobs);
  const blocks = loopBlocks(jobs, { runningId: active.id });
  expect(blocks.map((block) => block.id)).toEqual(["overview", "loop:active", "loop:paused", "loop:stopped"]);
  expect(blocks[0]!.body).toContain("1 active · 1 paused · 1 finished");
  expect(blocks[1]!.body).toContain(prompt);
  expect(blocks[1]!.body).toContain("Iterations: 3/25 · 22 remaining");
  expect(blocks[1]!.body).toContain("Iteration running");
  expect(blocks[2]!.body).toContain("Waiting for checks");
  expect(blocks[2]!.body).toContain("Reason: Interrupted");
  expect(blocks[2]!.body).toContain("automatic fallback");
  expect(blocks[2]!.labelColor).toBe("warning");
  expect(JSON.stringify(jobs)).toBe(before);
});

test("default prompt snapshots distinguish current configuration from finished history", () => {
  const active = createLoop("original default", null, 1_000, "default", "default");
  const finished = stopLoop({ ...active, id: "finished" }, "expired", "Limit reached");
  const blocks = loopBlocks([active, finished], { pendingId: active.id, defaultPrompt: { source: "project", prompt: "Current default\nDo bounded work" } });
  expect(blocks[1]!.body).toContain("Wake queued; iteration has not started");
  expect(blocks[1]!.body).toContain("Current default prompt: project");
  expect(blocks[1]!.body).toContain("Current default\nDo bounded work");
  expect(blocks[1]!.body).not.toContain("original default");
  expect(blocks[2]!.body).toContain("original default");
  expect(blocks[2]!.body).not.toContain("Current default");
});

test("empty and malformed saved display data cannot inject controls or break date rendering", () => {
  expect(loopBlocks([])[0]!.body).toContain("No loops are scheduled");
  const job = createLoop("literal `command`\n\x1b[31mwide 界\x1b[0m", 60_000, 1_000, "safe");
  const body = loopBlocks([{ ...job, expiresAt: Number.MAX_VALUE, nextRunAt: Number.MAX_VALUE }])[1]!.body;
  expect(body).toContain("literal `command`\nwide 界");
  expect(body).not.toContain("\x1b");
  expect(body).toContain("Next wake: unavailable");
});
