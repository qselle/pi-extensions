import { expect, test } from "bun:test";
import { join } from "node:path";
import { terminalSize } from "./transport.ts";
import { JobService } from "./service.ts";

test("terminal dimensions are bounded", () => {
  expect(terminalSize()).toEqual({ columns: 100, rows: 30 });
  for (const [columns, rows] of [[9, 30], [501, 30], [80, 1], [80, 201], [80.5, 30]]) expect(() => terminalSize(columns, rows)).toThrow();
});

test("Bun rejects PTYs without launching a broken native child", async () => {
  const service = new JobService();
  expect(() => service.start({ name: "pty", command: "echo hi", cwd: process.cwd(), executable: "/bin/sh", args: ["-c", "echo hi"], pty: true })).toThrow("require Node.js");
  expect(service.list()).toEqual([]);
  await service.shutdown();
});

test.skipIf(process.platform === "win32")("real PTY sessions under Node", async () => {
  const child = Bun.spawn(["node", join(import.meta.dir, "pty.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim()).toBe("PTY identity, input, resize, EOF, signals, redaction, exit and cleanup verified");
}, 15000);
