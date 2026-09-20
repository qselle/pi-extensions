import { expect, test } from "bun:test";
import { JobService, isActive } from "./service.ts";
import { join } from "node:path";

const input = (code: string, timeoutMs?: number) => ({ name: "test", command: "test command", executable: process.execPath, args: ["-e", code], cwd: process.cwd(), timeoutMs });

async function until(check: () => boolean, limit = 3000): Promise<void> {
  const deadline = Date.now() + limit;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("quick commands complete with bounded cursor output and exit codes", async () => {
  const service = new JobService(100);
  try {
    const job = service.start(input("process.stdout.write('x'.repeat(100000)); process.exitCode = 7"));
    const done = await service.wait(job.id, 3000);
    expect(done.status).toBe("failed");
    expect(done.code).toBe(7);
    expect(done.outputEnd).toBe(100000);
    const first = service.output(job.id, 0);
    expect(first.lost).toBe(36000);
    expect(first.text).toHaveLength(12000);
    expect(service.output(job.id, first.cursor).lost).toBe(0);
    expect(service.stop(job.id).status).toBe("failed");
  } finally { await service.shutdown(); }
});

test("stdin writes and EOF work without shell interpolation", async () => {
  const service = new JobService(100);
  try {
    const job = service.start(input("process.stdin.pipe(process.stdout)"));
    await service.write(job.id, "literal $(echo nope)\n🐈", true);
    expect((await service.wait(job.id, 3000)).status).toBe("completed");
    expect(service.output(job.id, 0).text).toBe("literal $(echo nope)\n🐈");
    await expect(service.write(job.id, "late")).rejects.toThrow("closed");
  } finally { await service.shutdown(); }
});

test("cancelling a wait leaves the process managed; explicit stop terminates it", async () => {
  const service = new JobService(100);
  try {
    const job = service.start(input("setInterval(() => {}, 1000)"));
    const controller = new AbortController();
    const waiting = service.wait(job.id, 3000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow("still managed");
    expect(isActive(service.get(job.id).status)).toBe(true);
    service.stop(job.id);
    expect((await service.wait(job.id, 3000)).status).toBe("stopped");
  } finally { await service.shutdown(); }
});

test("timeouts escalate for processes ignoring TERM", async () => {
  const service = new JobService(100);
  try {
    const job = service.start(input("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)", 500));
    await until(() => service.output(job.id).text.includes("ready"));
    expect((await service.wait(job.id, 3000)).status).toBe("timed-out");
  } finally { await service.shutdown(); }
});

test("missing executables fail without stranding a slot", async () => {
  const service = new JobService(100);
  try {
    const job = service.start({ ...input(""), executable: "/missing/pi-job-executable" });
    expect((await service.wait(job.id, 3000)).status).toBe("failed");
    expect(service.get(job.id).error).toContain("ENOENT");
  } finally { await service.shutdown(); }
});

test("redacts known secrets before metadata or split colored output reaches observers", async () => {
  const service = new JobService(100, () => ["secret-token"]);
  const observed: string[] = [];
  service.subscribe((job) => observed.push(JSON.stringify(job)));
  try {
    const job = service.start({ ...input("process.stdout.write('secret-'); setTimeout(() => process.stdout.write('\\x1b[31mtoken\\x1b[0m'), 30)"), name: "secret-token", command: "echo secret-token" });
    await service.wait(job.id, 3000);
    expect(service.output(job.id, 0).text).toBe("[redacted]");
    expect(observed.join("\n")).not.toContain("secret-token");
  } finally { await service.shutdown(); }
});

test("capacity is reserved synchronously and shutdown waits for active jobs", async () => {
  const service = new JobService(100);
  try {
    for (let i = 0; i < 4; i++) service.start(input("setInterval(() => {}, 1000)"));
    expect(() => service.start(input(""))).toThrow("Four jobs");
    await service.shutdown();
    expect(service.list().every((job) => job.status === "stopped")).toBe(true);
    expect(() => service.start(input(""))).toThrow("closed");
  } finally { await service.shutdown(); }
});

test.skipIf(process.platform === "win32")("tracks descendants after the shell exits and kills the remaining process group", async () => {
  const service = new JobService(100);
  try {
    const job = service.start(input(`const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(child.pid); child.unref();`));
    await until(() => Boolean(service.output(job.id).text.trim()));
    const pid = Number(service.output(job.id).text.trim());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(isActive(service.get(job.id).status)).toBe(true);
    await service.shutdown();
    expect(service.get(job.id).status).toBe("stopped");
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  } finally { await service.shutdown(); }
});

test.skipIf(process.platform === "win32")("process-exit fallback reaps a job without replacing signal handlers", async () => {
  const source = `import { JobService } from ${JSON.stringify(join(import.meta.dir, "service.ts"))};
    const service = new JobService();
    service.subscribe(job => { if (/^\\d+/.test(job.tail)) { console.log(job.tail.trim()); process.exit(0); } });
    service.start({ name: 'reaper', command: 'fixture', cwd: process.cwd(), executable: process.execPath,
      args: ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'] });`;
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const pid = Number(stdout.trim());
  try {
    expect(code, stderr).toBe(0);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  } finally {
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
});

test("a secret sent through stdin remains redacted after its source vault is cleared", async () => {
  let secrets: string[] = [];
  const service = new JobService(100, () => secrets);
  try {
    const job = service.start(input("let text = ''; process.stdin.on('data', part => text += part); process.stdin.on('end', () => setTimeout(() => process.stdout.write(text), 100))"));
    secrets = ["later-secret-value"];
    await service.write(job.id, secrets[0]!, true);
    secrets = [];
    await service.wait(job.id, 3000);
    expect(service.output(job.id, 0).text).toBe("[redacted]");
  } finally { await service.shutdown(); }
});
