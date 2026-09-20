import { expect, test } from "bun:test";
import { join } from "node:path";
for (const reverse of [false, true]) {
  test(`all extensions compose in the native loader (${reverse ? "reverse" : "forward"} order)`, async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "package.integration-fixture.ts"), ...(reverse ? ["--reverse"] : [])], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(stdout).toMatch(/All \d+ extensions loaded and shut down without network/);
  });
}
