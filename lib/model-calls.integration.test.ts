import { expect, test } from "bun:test";
import { join } from "node:path";

test("auxiliary model calls use Pi's configured registry and normalized transcripts", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "model-calls.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_OFFLINE: "1" } });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("Configured provider used for title, summary and side chat without network");
}, 15000);
