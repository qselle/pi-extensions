import { expect, test } from "bun:test";
import { join } from "node:path";

test("full transcript works with native Pi rendering and lifecycle events", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "view.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("transcript rendering, search, scrolling and lifecycle verified");
}, 15000);
