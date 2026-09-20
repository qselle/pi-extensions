import { expect, test } from "bun:test";
import { join } from "node:path";
test("image references and retrieval use Pi's native context and session APIs", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "runtime.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("native image deferral, retrieval, activation and unchanged history verified");
});
