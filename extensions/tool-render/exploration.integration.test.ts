import { expect, test } from "bun:test";
import { join } from "node:path";

test("native exploration cards survive reload/tree/compaction and stay bounded", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "exploration.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr || stdout).toBe(0);
  expect(stdout.trim()).toBe("native exploration replay, bounded previews, links and expansion verified");
}, 30_000);
