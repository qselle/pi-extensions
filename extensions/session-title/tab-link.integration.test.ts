import { expect, test } from "bun:test";
import { join } from "node:path";

test("Tab link follows native Pi lifecycle through a real Unix socket", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "tab-link.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("native Pi title events, commands, persistence and Herdr socket exchange verified");
});
