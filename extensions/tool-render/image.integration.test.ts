import { expect, test } from "bun:test";
import { join } from "node:path";

test("read images keep native preview ownership and portable history", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "image.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr || stdout).toBe(0);
  expect(stdout.trim()).toBe("native current and restored image previews, visibility preferences and embedded history verified");
}, 20_000);
