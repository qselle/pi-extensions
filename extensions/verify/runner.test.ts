import { describe, expect, test } from "bun:test";
import { VerifyCache, cacheKey, fileFingerprint, runCheck, type Exec, type ExecResult } from "./runner.ts";
import type { VerifyCheck } from "./config.ts";

const check: VerifyCheck = { match: ["**/*.ts"], command: "bun test {dir}", name: "tests", timeoutMs: 60_000 };

function fakeExec(result: Partial<ExecResult>, calls: any[] = []): Exec {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: "", stderr: "", code: 0, ...result };
  };
}

const base = { check, file: "extensions/verify/config.ts", cwd: "/repo", spillTokenLimit: 2_500, fingerprint: "fp1" };

describe("fileFingerprint", () => {
  test("uses size and mtime", () => {
    expect(fileFingerprint("/x", (() => ({ size: 10, mtimeMs: 5 })) as never)).toBe("10:5");
  });
  test("uses a stable marker when stat fails, so caching stays deterministic", () => {
    const missing = (() => { throw new Error("enoent"); }) as never;
    expect(fileFingerprint("/nope", missing)).toBe("missing");
    expect(fileFingerprint("/nope", missing)).toBe(fileFingerprint("/nope", missing));
  });
});

describe("runCheck success path", () => {
  test("runs the templated command through a shell in the project cwd", async () => {
    const calls: any[] = [];
    const outcome = await runCheck({ ...base, exec: fakeExec({ code: 0 }, calls) });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBeUndefined();
    expect(outcome.command).toBe("bun test 'extensions/verify'");
    expect(calls[0].args[0]).toBe("-c");
    expect(calls[0].args[1]).toBe("bun test 'extensions/verify'");
    expect(calls[0].options.cwd).toBe("/repo");
    expect(calls[0].options.timeout).toBe(60_000);
  });

  test("uses . as the dir for a root-level file", async () => {
    const outcome = await runCheck({ ...base, file: "index.ts", exec: fakeExec({ code: 0 }) });
    expect(outcome.command).toBe("bun test '.'");
  });

  test("records duration", async () => {
    let clock = 1_000;
    const outcome = await runCheck({ ...base, exec: fakeExec({ code: 0 }), now: () => (clock += 25) });
    expect(outcome.durationMs).toBe(25);
  });
});

describe("runCheck failure path", () => {
  test("returns injectable failure text with the output", async () => {
    const outcome = await runCheck({
      ...base,
      exec: fakeExec({ code: 1, stdout: "1 failing\nexpected true", stderr: "" }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(1);
    expect(outcome.text).toContain("verify: tests failed (exit 1)");
    expect(outcome.text).toContain("1 failing");
    expect(outcome.text).toContain("The edit was applied.");
  });

  test("merges stderr into the reported output", async () => {
    const outcome = await runCheck({ ...base, exec: fakeExec({ code: 2, stdout: "out", stderr: "err" }) });
    expect(outcome.text).toContain("out");
    expect(outcome.text).toContain("err");
  });

  test("reports a killed process as a timeout", async () => {
    const outcome = await runCheck({ ...base, exec: fakeExec({ code: null, killed: true }) });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.text).toContain("timed out after 60s");
  });

  test("spills oversized output and references the file", async () => {
    const big = Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join("\n");
    const outcome = await runCheck({
      ...base,
      spillTokenLimit: 50,
      spillDirectory: "/tmp",
      exec: fakeExec({ code: 1, stdout: big }),
    });
    expect(outcome.spillPath).toBe("/tmp/verify-output.txt");
    expect(outcome.text).toContain("Full output: /tmp/verify-output.txt");
    expect(outcome.text!.length).toBeLessThan(big.length);
  });

  test("reports a spawn failure as a configuration problem, not a failing check", async () => {
    const outcome = await runCheck({
      ...base,
      exec: async () => { throw new Error("ENOENT bun"); },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("could not run the check: ENOENT bun");
  });
});

describe("runCheck abort", () => {
  test("an aborted run reports no failure", async () => {
    const controller = new AbortController();
    const outcome = await runCheck({
      ...base,
      signal: controller.signal,
      exec: async () => { controller.abort(); return { stdout: "", stderr: "", code: null, killed: true }; },
    });
    // Esc cancelled the turn; injecting a failure would blame the user's cancel.
    expect(outcome.aborted).toBe(true);
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBeUndefined();
  });

  test("an aborted run is not cached", async () => {
    const controller = new AbortController();
    const cache = new VerifyCache();
    await runCheck({
      ...base,
      cache,
      signal: controller.signal,
      exec: async () => { controller.abort(); return { stdout: "", stderr: "", code: null }; },
    });
    expect(cache.size).toBe(0);
  });
});

describe("caching", () => {
  test("an identical invocation is served from cache", async () => {
    const cache = new VerifyCache();
    const calls: any[] = [];
    const exec = fakeExec({ code: 1, stdout: "boom" }, calls);
    const first = await runCheck({ ...base, cache, exec });
    const second = await runCheck({ ...base, cache, exec });
    expect(calls).toHaveLength(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.text).toBe(first.text);
  });

  test("a changed file fingerprint re-runs the check", async () => {
    const cache = new VerifyCache();
    const calls: any[] = [];
    const exec = fakeExec({ code: 0 }, calls);
    await runCheck({ ...base, cache, exec, fingerprint: "fp1" });
    await runCheck({ ...base, cache, exec, fingerprint: "fp2" });
    expect(calls).toHaveLength(2);
  });

  test("a different file re-runs even with the same command", async () => {
    const cache = new VerifyCache();
    const calls: any[] = [];
    const exec = fakeExec({ code: 0 }, calls);
    await runCheck({ ...base, cache, exec, file: "extensions/verify/a.ts", fingerprint: "a" });
    await runCheck({ ...base, cache, exec, file: "extensions/verify/b.ts", fingerprint: "b" });
    expect(calls).toHaveLength(2);
  });

  test("clearing the cache forces a re-run", async () => {
    const cache = new VerifyCache();
    const calls: any[] = [];
    const exec = fakeExec({ code: 0 }, calls);
    await runCheck({ ...base, cache, exec });
    cache.clear();
    await runCheck({ ...base, cache, exec });
    expect(calls).toHaveLength(2);
    expect(cache.size).toBe(1);
  });

  test("cacheKey separates command from fingerprint", () => {
    expect(cacheKey("a", "b")).not.toBe(cacheKey("ab", ""));
  });
});
