import { expect, test } from "bun:test";
import { join } from "node:path";
test("child continuity crosses real session files without automatic restart or duplicated results", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "continuity.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, error).toBe(0); expect(out).toContain("verified");
});
