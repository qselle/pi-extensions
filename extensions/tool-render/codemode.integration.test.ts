import { expect, test } from "bun:test";
import { join } from "node:path";

test("codemode cards restyle Pi's tool with one shared call and result block", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "codemode.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr || stdout).toBe(0);
  expect(stdout.trim()).toBe("tool-render codemode verified");
}, 30_000);
