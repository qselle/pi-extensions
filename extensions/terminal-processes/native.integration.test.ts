import { expect, test } from "bun:test";
import { join } from "node:path";

test("terminal panes use native Pi lifecycle and disposable Herdr socket fixtures", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "native.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("native Pi persistence, reload, resume, fork isolation, rendering and Herdr wire protocol verified");
}, 15000);
