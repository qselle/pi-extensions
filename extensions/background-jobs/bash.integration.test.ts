import { expect, test } from "bun:test";
import { join } from "node:path";

test("managed bash keeps execution and rendering in both extension load orders", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "bash.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("managed bash and renderer compose in both load orders");
}, 15000);
