import { expect, test } from "bun:test";
import { join } from "node:path";

test("goal and schedule warnings reach Telegram through native Pi events without exposing task data", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "attention.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("native goal and schedule attention delivery, quiet cancellation and session isolation verified in both load orders");
}, 20_000);
