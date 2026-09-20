import { expect, test } from "bun:test";
import { join } from "node:path";
test("companion composes with the native editor and prompt in both orders", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "editor.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("native companion composition verified in both decorator orders");
});
