import { expect, test } from "bun:test";
import { join } from "node:path";

test("deferred controls activate additively and survive resume on the real host", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "deferred-tools.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("deferred controls activate additively and survive resume");
});
