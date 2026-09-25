import { expect, test } from "bun:test";
import { join } from "node:path";

test("child keyboard navigation composes with native editors and preserves per-child search", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "editor-navigation.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, error).toBe(0);
  expect(output).toContain("native child navigation, editor composition, drafts, search, lifecycle and widths verified");
}, 15_000);
