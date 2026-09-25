import { expect, test } from "bun:test";
import { join } from "node:path";
test("native Pi runtimes coordinate reloads without model input", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "native.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("native two-runtime reload handshake, dialogs, command loading and collision sink verified");
}, 15_000);
