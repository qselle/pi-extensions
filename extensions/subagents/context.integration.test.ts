import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const contextModule = resolve(import.meta.dir, "context.ts");

test("creates fresh, summary, and fork child sessions through Pi's real session API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagents-context-integration-"));
  const script = join(directory, "verify-context.ts");
  await writeFile(script, `
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createChildContext } from ${JSON.stringify(contextModule)};

export default async function () {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-context-parent-"));
  try {
    const parent = SessionManager.create(root, root);
    parent.appendMessage({ role: "user", content: "Parent requirement", timestamp: Date.now() });
    parent.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Parent decision" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const ctx = { cwd: root, sessionManager: parent };

    const fresh = await createChildContext(ctx, "fresh");
    const freshSession = SessionManager.open(fresh.sessionFile, fresh.directory, root);
    if (freshSession.buildSessionContext().messages.length !== 0) throw new Error("fresh context inherited parent messages");
    const freshDir = fresh.directory;
    await fresh.cleanup();
    if (existsSync(freshDir)) throw new Error("fresh context cleanup failed");

    const summary = await createChildContext(ctx, "summary", "Summary handoff");
    const summarySession = SessionManager.open(summary.sessionFile, summary.directory, root);
    const summaryMessages = summarySession.buildSessionContext().messages;
    if (!JSON.stringify(summaryMessages).includes("Summary handoff")) throw new Error("summary handoff missing");
    await summary.cleanup();

    const fork = await createChildContext(ctx, "fork");
    const forkSession = SessionManager.open(fork.sessionFile, fork.directory, root);
    const forkText = JSON.stringify(forkSession.buildSessionContext().messages);
    if (!forkText.includes("Parent requirement") || !forkText.includes("Parent decision")) throw new Error("fork context missing parent messages");
    if (fork.inheritedMessages !== 2) throw new Error("fork inherited message count is wrong");
    await fork.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
`, "utf8");

  try {
    const result = Bun.spawnSync({
      cmd: ["pi", "--no-extensions", "-e", script, "--list-models"],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
