import { expect, test } from "bun:test";
import { join } from "node:path";
test("native multi-round runs persist a renderable full-turn summary", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "runtime.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("native multi-round summary persistence and rendering verified");
});
