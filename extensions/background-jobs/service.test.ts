import { expect, test } from "bun:test";
import { JobService, isActive, LOG_CAPACITY, MAX_ACTIVE_JOBS, SHUTDOWN_SLACK_MS } from "./service.ts";
import { join } from "node:path";

const input = (code: string, timeoutMs?: number, stdin?: boolean) => ({ name: "test", command: "test command", executable: process.execPath, args: ["-e", code], cwd: process.cwd(), timeoutMs, stdin });

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
    const job = service.start(input("process.stdout.write('x'.repeat(200000)); process.exitCode = 7"));
    const done = await service.wait(job.id, 3000);
    expect(done.status).toBe("failed");
    expect(done.code).toBe(7);
    expect(done.outputEnd).toBe(200000);
    const first = service.output(job.id, 0);
    expect(first.lost).toBe(200000 - LOG_CAPACITY);
    expect(first.text).toHaveLength(12000);
    expect(service.output(job.id, first.cursor).lost).toBe(0);
    expect(service.stop(job.id).status).toBe("failed");
  } finally { await service.shutdown(); }
});

test("stdin writes and EOF work without shell interpolation", async () => {
  const service = new JobService(100);
  try {
    const job = service.start(input("process.stdin.pipe(process.stdout)", undefined, true));
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

test("sixteen jobs run concurrently; capacity is reserved synchronously and shutdown waits for active jobs", async () => {
  const service = new JobService(100);
  try {
    for (let i = 0; i < MAX_ACTIVE_JOBS; i++) service.start(input("setInterval(() => {}, 1000)"));
    expect(service.list().filter((job) => isActive(job.status))).toHaveLength(16);
    expect(() => service.start(input(""))).toThrow("16 jobs are already active");
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
    const job = service.start(input("let text = ''; process.stdin.on('data', part => text += part); process.stdin.on('end', () => setTimeout(() => process.stdout.write(text), 100))", undefined, true));
    secrets = ["later-secret-value"];
    await service.write(job.id, secrets[0]!, true);
    secrets = [];
    await service.wait(job.id, 3000);
    expect(service.output(job.id, 0).text).toBe("[redacted]");
  } finally { await service.shutdown(); }
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test.skipIf(process.platform === "win32")("pipe jobs start with stdin at EOF unless input is requested", async () => {
  const service = new JobService(100);
  try {
    const started = Date.now();
    const closed = service.start({ name: "cat", command: "cat", executable: "/bin/sh", args: ["-c", "cat"], cwd: process.cwd() });
    const done = await service.wait(closed.id, 3000);
    expect(done.status).toBe("completed");
    expect(done.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(1500);
    await expect(service.write(closed.id, "late")).rejects.toThrow("stdin: true");
    const open = service.start({ name: "cat", command: "cat", executable: "/bin/sh", args: ["-c", "cat"], cwd: process.cwd(), stdin: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isActive(service.get(open.id).status)).toBe(true);
    await service.write(open.id, "piped", true);
    expect((await service.wait(open.id, 3000)).status).toBe("completed");
    expect(service.output(open.id, 0).text).toBe("piped");
  } finally { await service.shutdown(); }
});

test.skipIf(process.platform === "win32")("a daemon that escapes the process group but keeps the pipes open does not hold the job", async () => {
  const service = new JobService(100);
  let pid = 0;
  try {
    const started = Date.now();
    const job = service.start(input(`const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
      console.log(child.pid); child.unref();`));
    const done = await service.wait(job.id, 5000);
    pid = Number(service.output(job.id, 0).text.trim());
    expect(done.status).toBe("completed");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(alive(pid)).toBe(true);
  } finally {
    if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await service.shutdown();
  }
});

test.skipIf(process.platform === "win32")("shutdown with a TERM-ignoring leader and an escaped daemon stays within its bound", async () => {
  const grace = 300;
  const service = new JobService(grace);
  let pid = 0;
  try {
    const job = service.start(input(`process.on('SIGTERM', () => {});
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
      console.log(child.pid); child.unref(); setInterval(() => {}, 1000);`));
    await until(() => Boolean(service.output(job.id).text.trim()));
    pid = Number(service.output(job.id, 0).text.trim());
    const started = Date.now();
    await service.shutdown();
    expect(Date.now() - started).toBeLessThan(grace + SHUTDOWN_SLACK_MS);
    expect(service.get(job.id).status).toBe("stopped");
  } finally {
    if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await service.shutdown();
  }
});

test.skipIf(process.platform === "win32")("shutdown abandons a job whose exit is never observed after grace plus slack", async () => {
  const grace = 100;
  const service = new JobService(grace);
  try {
    const job = service.start(input("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"));
    await until(() => service.get(job.id).status === "running");
    // Simulate a lost exit notification: nothing will settle the job on its own.
    (service as unknown as { settle: () => void }).settle = () => {};
    const started = Date.now();
    await service.shutdown();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(grace + SHUTDOWN_SLACK_MS - 50);
    expect(took).toBeLessThan(grace + SHUTDOWN_SLACK_MS + 1000);
    expect(service.get(job.id).status).toBe("stopped");
  } finally { await service.shutdown(); }
});

test("waits accept up to five minutes", async () => {
  const service = new JobService(100);
  try {
    const job = service.start(input(""));
    expect((await service.wait(job.id, 300_000)).status).toBe("completed");
    await expect(service.wait(job.id, 300_001)).rejects.toThrow("0–300000");
  } finally { await service.shutdown(); }
});

test("live jobs hold one hard-exit reaper, released when they settle", async () => {
  const reapers: Map<symbol, () => void> = (globalThis as any)[Symbol.for("@qselle/pi-extensions.process-exit-reaper.v1")].callbacks;
  const before = reapers.size;
  const service = new JobService(100);
  try {
    const job = service.start(input("setInterval(() => {}, 1000)"));
    await until(() => service.get(job.id).status === "running");
    expect(reapers.size).toBe(before + 1);
    service.stop(job.id);
    await service.wait(job.id, 3000);
    expect(reapers.size).toBe(before);
  } finally { await service.shutdown(); }
});
