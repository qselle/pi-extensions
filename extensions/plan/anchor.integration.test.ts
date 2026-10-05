import { expect, test } from "bun:test";
import { join } from "node:path";

async function run(fixture: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, fixture)], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  return stdout.trim();
}

test("plan context stays cache-safe and anchors hidden plans once", async () => {
  expect(await run("anchor.integration-fixture.ts")).toBe("plan anchors keep request prefixes stable and restate hidden plans once");
});

test("idle anchors append without starting a turn and survive repeated compaction without duplicates", async () => {
  expect(await run("anchor-runtime.integration-fixture.ts")).toBe("idle plan anchors append without a turn and are never duplicated");
});
