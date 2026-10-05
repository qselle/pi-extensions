import { expect, test } from "bun:test";
import { join } from "node:path";
test("plan context stays cache-safe and anchors hidden plans once", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "anchor.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("plan anchors keep request prefixes stable and restate hidden plans once");
});
