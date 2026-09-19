import { expect, test } from "bun:test";
import { join } from "node:path";
test("accent decoration preserves native editor interactions", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "editor.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("native editor input, cursor, paste, accent and working status verified");
});
