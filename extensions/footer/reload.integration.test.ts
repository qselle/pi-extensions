import { expect, test } from "bun:test";
import { join } from "node:path";
test("native footer reload does not retain shared event subscriptions", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "reload.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("native footer reload releases and renews every shared-bus listener exactly once");
}, 10_000);
