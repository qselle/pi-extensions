import { expect, test } from "bun:test";
import { join } from "node:path";
test("native Codex adapter sends the opted-in tier and removes it when disabled", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "transport.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("Codex fast payload verified without network");
});
