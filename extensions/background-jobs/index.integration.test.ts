import { expect, test } from "bun:test";
import { join } from "node:path";

test("managed job tools work through native Pi APIs", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("job tools, metadata, rendering and lifecycle verified");
}, 15000);
