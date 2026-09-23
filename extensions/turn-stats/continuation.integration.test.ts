import { expect, test } from "bun:test";
import { join } from "node:path";

test("native pre-settle continuation preserves whole-turn totals and timing", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "continuation.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("Native pre-settle continuation preserves whole-turn accounting");
});
