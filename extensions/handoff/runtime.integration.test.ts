import { expect, test } from "bun:test";
import { join } from "node:path";
test("handoff replaces context through real Pi runtime without modifying the original session", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "runtime.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("handoff guards, real session replacement, workflow state and persistence verified");
}, 15000);
