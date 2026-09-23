import { expect, test } from "bun:test";
import { join } from "node:path";

test("palette uses real Pi input/rendering and preserves drafts and lifecycle boundaries", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "runtime.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr || stdout);
  expect(stdout.trim()).toBe("command palette verified");
  expect(stderr).toBe("");
});
