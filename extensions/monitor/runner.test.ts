import { expect, test } from "bun:test";
import { MAX_CAPTURE_BYTES, runBoundedProcess } from "./runner.ts";

test("caps retained process output while hashing the complete streams", async () => {
  const common = "x".repeat(MAX_CAPTURE_BYTES + 5_000);
  const first = await runBoundedProcess(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(`${common}a`)})`], process.cwd(), 5_000);
  const second = await runBoundedProcess(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(`${common}b`)})`], process.cwd(), 5_000);

  expect(Buffer.byteLength(first.stdout)).toBeLessThan(MAX_CAPTURE_BYTES + 100);
  expect(first.stdout).toContain("bytes omitted");
  expect(first.stdoutTruncated).toBe(true);
  expect(first.stdoutDigest).toHaveLength(64);
  expect(first.stdoutDigest).not.toBe(second.stdoutDigest);
});

test("terminates a running process when its monitor is aborted", async () => {
  const controller = new AbortController();
  const running = runBoundedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), 5_000, controller.signal);
  setTimeout(() => controller.abort(), 10);
  const result = await running;
  expect(result.killed).toBe(true);
});
