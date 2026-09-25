import { expect, test } from "bun:test";
import { join } from "node:path";

test("native reload releases old Bash ownership and styling when extensions are disabled", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "reload.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("native Bash reload ownership and style cleanup verified");
}, 15000);
