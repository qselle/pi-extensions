import { expect, test } from "bun:test";
import { join } from "node:path";

test("loop inspection uses native searchable panels without scheduling or persistence", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "panel.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("loop inspection and lifecycle verified");
});
