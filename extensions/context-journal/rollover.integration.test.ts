import { expect, test } from "bun:test";
import { join } from "node:path";
test("rollover commits a real Pi compaction without a network request", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "rollover.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("native no-summary compaction, journal injection, history and persistence verified");
}, 15000);
