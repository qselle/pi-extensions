import { expect, test } from "bun:test";
import { join } from "node:path";

test("a spent emergency reserve rolls over to saved notes and continues", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "exhausted.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr || stdout).toBe(0);
  expect(stdout.trim()).toBe("emergency reserve rolls over to saved notes and continues");
}, 15000);
