import { expect, test } from "bun:test";
import { join } from "node:path";
test("nested plan UI works with native terminal keys and widths", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "tree.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("nested plan navigation, collapse, active-step visibility and native widths verified");
});
