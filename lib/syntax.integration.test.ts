import { expect, test } from "bun:test";
import { join } from "node:path";

test("native Shiki initialization, source preservation, colors and bounded fallbacks", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "syntax.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("Native Shiki source, styles, aliases, cache and fallback verified");
}, 15000);
