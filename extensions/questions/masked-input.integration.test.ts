import { expect, test } from "bun:test";
import { join } from "node:path";

test("preserves mid-string editing while masking with Pi's real Input", async () => {
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "masked-input.integration-fixture.ts"),
  ], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (exitCode !== 0) throw new Error(stderr || stdout);
  expect(stdout.trim()).toBe("masked input cursor preserved");
  expect(stderr).toBe("");
});
