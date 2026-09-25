import { expect, test } from "bun:test";
import { join } from "node:path";

test("explicit child reports cross native RPC and session boundaries without forcing a parent turn", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "report.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, errors).toBe(0);
  expect(output).toContain("verified");
}, 10_000);
