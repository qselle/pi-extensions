import { expect, test } from "bun:test";
import { join } from "node:path";

test("session topics follow Pi metadata and lifecycle through its public API", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "topics.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("native Pi session topics, renaming, fork isolation and recovery commands verified");
});
