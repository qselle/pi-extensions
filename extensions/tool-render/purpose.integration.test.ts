import { expect, test } from "bun:test";
import { join } from "node:path";

test("native file tools preserve execution schemas and show purpose once across replay", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "purpose.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr || stdout).toBe(0);
  expect(stdout.trim()).toBe("native file schemas, purpose captions, execution and replay verified");
}, 30_000);
