import { expect, test } from "bun:test";
import { join } from "node:path";

test("shell commands retain syntax colors and source text at different widths", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "command.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("Shell command colors, wrapping, theme changes and source preservation verified");
}, 15000);
