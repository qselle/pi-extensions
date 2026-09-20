import { expect, test } from "bun:test";
import { join } from "node:path";

test.skipIf(process.platform === "win32")("page reader process boundaries, cancellation, and cleanup", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "reader.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("reader process lifecycle verified");
}, 10000);
