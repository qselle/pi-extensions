import { expect, test } from "bun:test";
import { join } from "node:path";

test("native image storage preserves originals, accounting, history, reload, forks and portable exports", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "storage.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("native stored-image roundtrip, deferral, reload, fork and portable export verified");
}, 15000);
