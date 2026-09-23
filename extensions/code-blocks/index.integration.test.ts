import { expect, test } from "bun:test";
import { join } from "node:path";
test("public transformer integrates Shiki with native Markdown and theme fallback", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("Shiki code blocks, source preservation, native rendering and theme fallback verified");
}, 15000);
