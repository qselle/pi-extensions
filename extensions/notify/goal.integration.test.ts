import { expect, test } from "bun:test";
import { join } from "node:path";
test("notifications track goal attention, focus and tool failures in real Pi runtimes", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "goal.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("native notification goal attention, focus fallback and failure recovery verified");
});
