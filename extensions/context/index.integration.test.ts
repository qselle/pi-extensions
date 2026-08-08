import { expect, test } from "bun:test";
import { join } from "node:path";

test("matches Pi's real custom-message conversion and estimator", async () => {
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "index.integration-fixture.ts"),
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
  expect(stdout.trim()).toBe("context integration verified");
  expect(stderr).toBe("");
});
