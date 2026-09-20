import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { JobService, isActive } from "./service.ts";

const service = new JobService(100, () => ["secret-pty-value"]);
const launch = (command: string, extra = {}) => service.start({ command, name: "Terminal test", cwd: process.cwd(), executable: "/bin/sh", args: ["-c", command], pty: true, ...extra });
async function until(id: string, text: string) {
  for (let count = 0; count < 150; count++) {
    if (service.output(id).text.includes(text)) return;
    if (!isActive(service.get(id).status)) break;
    await delay(20);
  }
  assert.fail(`Missing ${JSON.stringify(text)} in ${JSON.stringify(service.get(id))}`);
}
try {
  const interactive = launch('test -t 0 && test -t 1 || exit 9; stty -echo; stty size; printf "READY\\n"; read value; printf "got:%s\\n" "$value"; stty size', { columns: 90, rows: 25 });
  await until(interactive.id, "READY");
  assert(service.output(interactive.id).text.includes("25 90"));
  const resized = service.resize(interactive.id, 120, 40);
  assert.equal(resized.columns, 120);
  assert.equal(resized.rows, 40);
  await assert.rejects(service.write(interactive.id, "", true), /half-closed/);
  await service.write(interactive.id, "hello\n");
  await service.wait(interactive.id, 3000);
  assert.equal(service.get(interactive.id).status, "completed");
  assert(service.output(interactive.id).text.includes("got:hello"));
  assert(service.output(interactive.id).text.includes("40 120"));
  assert.throws(() => service.resize(interactive.id, 100, 30), /no longer/);

  const secret = launch('stty -echo; printf "READY\\n"; read value; printf "%s" "$value"');
  await until(secret.id, "READY");
  await service.write(secret.id, "secret-pty-value\n");
  await service.wait(secret.id, 3000);
  assert(!service.output(secret.id).text.includes("secret-pty-value"));
  assert(service.output(secret.id).text.includes("[redacted]"));

  const eof = launch('stty -echo; printf "READY\\n"; cat; printf "EOF-SEEN\\n"');
  await until(eof.id, "READY");
  await service.write(eof.id, "\x04");
  await service.wait(eof.id, 3000);
  assert.equal(service.get(eof.id).status, "completed");
  assert(service.output(eof.id).text.includes("EOF-SEEN"));

  const interrupted = launch('printf "READY\\n"; exec cat');
  await until(interrupted.id, "READY");
  await service.write(interrupted.id, "\x03");
  await service.wait(interrupted.id, 3000);
  assert(!isActive(service.get(interrupted.id).status));
  assert.equal(service.get(interrupted.id).signal, "SIGINT");

  const failure = launch('printf "failure-output\\n"; exit 7');
  await service.wait(failure.id, 3000);
  assert.equal(service.get(failure.id).code, 7);
  assert.equal(service.get(failure.id).status, "failed");

  const slow = launch('trap "" TERM; printf "READY\\n"; while :; do sleep 1; done', { timeoutMs: 300 });
  await until(slow.id, "READY");
  await service.wait(slow.id, 3000);
  assert.equal(service.get(slow.id).status, "timed-out");

  const cleanup = launch('printf "READY\\n"; exec cat');
  await until(cleanup.id, "READY");
  await service.shutdown();
  assert.equal(service.get(cleanup.id).status, "stopped");
  console.log("PTY identity, input, resize, EOF, signals, redaction, exit and cleanup verified");
} finally { await service.shutdown(); }
