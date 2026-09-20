import { expect, test } from "bun:test";
import { join } from "node:path";
test("subagent navigation discards stale selections", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "navigation.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_SUBAGENT_CHILD: "0" } });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("subagent selections cannot cross session lifecycle boundaries");
});
