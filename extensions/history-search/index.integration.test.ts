import { expect, test } from "bun:test";
import { join } from "node:path";
test("history picker appends to seeded queries and preserves session/editor boundaries", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("history picker lifecycle and editor composition verified");
});
