import { expect, test } from "bun:test";
import { join } from "node:path";

test("cards cache settled rows and render streaming, diff, caption, status and wrapping", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "cards.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr || stdout).toBe(0);
  expect(stdout.trim()).toBe("tool-render cards verified");
}, 30_000);
