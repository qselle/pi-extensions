import { expect, test } from "bun:test";
import { join } from "node:path";
test("working styles render in the native indicator and decorated editor", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "render.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("native working styles and editor bounds verified");
});
