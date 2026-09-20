import { expect, test } from "bun:test";
import { join } from "node:path";

test("rewind fork contract with real Pi runtime and isolated sessions", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fork.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("real fork preserves original and excludes selected prompt");
}, 15000);
