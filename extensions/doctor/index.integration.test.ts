import { expect, test } from "bun:test";
import { join } from "node:path";
test("doctor works with native Pi rendering", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("doctor report, narrow UI and session cleanup verified");
});
