import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RpcAgentClient } from "./rpc.ts";

const directories: string[] = [];
const livePids = new Set<number>();

afterEach(async () => {
  for (const pid of livePids) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  livePids.clear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("uses strict JSONL, preserves Unicode separators, and declines child dialogs", async () => {
  const directory = await tempDirectory("rpc-jsonl");
  const script = join(directory, "child.mjs");
  await writeFile(script, `
let buffer = "";
let stateRequest;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index).replace(/\\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "get_state") {
      stateRequest = message;
      process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "dialog", method: "confirm" }) + "\\n");
    } else if (message.type === "extension_ui_response") {
      if (message.confirmed !== false) process.exit(12);
      process.stdout.write(JSON.stringify({ type: "response", id: stateRequest.id, command: "get_state", success: true, data: {} }) + "\\n");
    } else if (message.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "response", id: message.id, command: "prompt", success: true }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "left right" }] } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
  }
});
`, "utf8");

  const client = new RpcAgentClient({ command: process.execPath, args: [script], cwd: directory });
  const events: any[] = [];
  client.onEvent((event) => events.push(event));
  await client.start();
  await client.prompt("hello");
  await waitUntil(() => events.some((event) => event.type === "agent_settled"));
  expect(events.find((event) => event.type === "message_end")?.message.content[0].text).toBe("left right");
  await client.stop();
});

test("rejects startup failures and reaps the child process", async () => {
  const directory = await tempDirectory("rpc-reject");
  const pidFile = join(directory, "pid");
  const script = join(directory, "child.mjs");
  await writeFile(script, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.once("data", (chunk) => {
  const message = JSON.parse(String(chunk).trim());
  process.stdout.write(JSON.stringify({ type: "response", id: message.id, command: "get_state", success: false, error: "startup denied" }) + "\\n");
});
setInterval(() => {}, 1000);
`, "utf8");

  const client = new RpcAgentClient({ command: process.execPath, args: [script], cwd: directory });
  await expect(client.start()).rejects.toThrow("startup denied");
  const pid = Number(await Bun.file(pidFile).text());
  expect(processExists(pid)).toBe(false);
});

test("bounds stderr and rejects oversized RPC records", async () => {
  const directory = await tempDirectory("rpc-bounds");
  const script = join(directory, "child.mjs");
  await writeFile(script, `
process.stderr.write("é".repeat(20_000));
process.stdin.once("data", () => process.stdout.write("x".repeat(2 * 1024 * 1024 + 1)));
setInterval(() => {}, 1000);
`, "utf8");
  const client = new RpcAgentClient({ command: process.execPath, args: [script], cwd: directory });
  await expect(client.start()).rejects.toThrow("RPC record exceeded");
  expect(Buffer.byteLength(client.stderr())).toBeLessThanOrEqual(16 * 1024);
});

test("escalates from SIGTERM to SIGKILL for stubborn child processes", async () => {
  if (process.platform === "win32") return;
  const directory = await tempDirectory("rpc-stubborn");
  const script = join(directory, "child.mjs");
  await writeFile(script, `
process.on("SIGTERM", () => {});
process.stdin.on("data", (chunk) => {
  const message = JSON.parse(String(chunk).trim());
  process.stdout.write(JSON.stringify({ type: "response", id: message.id, command: message.type, success: true, data: {} }) + "\\n");
});
setInterval(() => {}, 1000);
`, "utf8");
  const client = new RpcAgentClient({ command: process.execPath, args: [script], cwd: directory });
  await client.start();
  const pid = client.pid!;
  livePids.add(pid);
  await client.stop();
  expect(processExists(pid)).toBe(false);
  livePids.delete(pid);
}, 5_000);

async function tempDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pi-subagents-${label}-`));
  directories.push(directory);
  return directory;
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for RPC event");
}
