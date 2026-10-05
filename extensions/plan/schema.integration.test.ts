import { expect, test } from "bun:test";
import { join } from "node:path";
test("update_plan prepares flat rows and validates a strict schema", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "schema.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("update_plan accepts flat depth rows and rejects unknown fields");
});
