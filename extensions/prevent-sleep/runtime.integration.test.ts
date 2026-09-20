import { expect, test } from "bun:test";
import { join } from "node:path";

// Opt-in because this test briefly changes an OS power assertion.
test.skipIf(process.platform !== "darwin" || process.env.PI_TEST_SLEEP_ASSERTION !== "1")("native macOS helper acquires and releases its OS assertion", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "runtime.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("macOS idle-sleep assertion acquisition and release verified");
}, 30000);
