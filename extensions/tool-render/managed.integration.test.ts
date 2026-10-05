import { expect, test } from "bun:test";
import { join } from "node:path";

test("managed bash results render status, output, job IDs and live time on tool-render cards", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "managed.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr || stdout).toBe(0);
  expect(stdout.trim()).toBe("managed bash cards verified");
}, 30_000);
