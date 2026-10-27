import { expect, test } from "bun:test";
import { join } from "node:path";

test("journal notes and budget notices keep the request prefix stable", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "cache.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr || stdout).toBe(0);
  expect(stdout.trim()).toBe("journal requests keep a stable cached prefix");
}, 15000);
