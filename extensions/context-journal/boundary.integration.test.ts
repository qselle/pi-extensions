import { expect, test } from "bun:test";
import { join } from "node:path";

test("native journal boundary continues once and preserves hard exits", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "boundary.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr || stdout).toBe(0);
  expect(stdout.trim()).toBe("native rollover boundary, continuation, cancellation and persistence verified");
}, 15000);
