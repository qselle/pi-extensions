import { expect, test } from "bun:test";
import { join } from "node:path";
test("schedule panel renders and searches full prompts with native Pi components", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "panel.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("schedule panel verified");
});
