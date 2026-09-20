import { expect, test } from "bun:test";
import { join } from "node:path";
test("side-chat async requests remain isolated across lifecycle changes", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "lifecycle.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("side-chat title and authentication lifecycle verified");
});
