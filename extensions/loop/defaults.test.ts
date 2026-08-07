import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_LOOP_PROMPT, loadDefaultLoopPrompt } from "./defaults.ts";

test("loads project then user loop.md and otherwise uses the maintenance prompt", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-loop-default-"));
  try {
    const project = join(root, "project");
    const agent = join(root, "agent");
    mkdirSync(join(project, ".pi"), { recursive: true });
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "loop.md"), "user maintenance\n");

    expect(loadDefaultLoopPrompt(project, agent)).toMatchObject({ prompt: "user maintenance", source: "user" });
    writeFileSync(join(project, ".pi", "loop.md"), "project maintenance\n");
    expect(loadDefaultLoopPrompt(project, agent)).toMatchObject({ prompt: "project maintenance", source: "project" });
    expect(loadDefaultLoopPrompt(project, agent, false)).toMatchObject({ prompt: "user maintenance", source: "user" });
    expect(loadDefaultLoopPrompt(join(root, "missing"), join(root, "missing-agent"))).toEqual({
      prompt: BUILTIN_LOOP_PROMPT,
      source: "builtin",
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ignores symlinked and oversized loop.md files", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-loop-default-safe-"));
  try {
    const project = join(root, "project");
    const agent = join(root, "agent");
    mkdirSync(join(project, ".pi"), { recursive: true });
    mkdirSync(agent, { recursive: true });
    const target = join(root, "target.md");
    writeFileSync(target, "do something unsafe");
    symlinkSync(target, join(project, ".pi", "loop.md"));
    writeFileSync(join(agent, "loop.md"), "x".repeat(100_001));
    expect(loadDefaultLoopPrompt(project, agent).source).toBe("builtin");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
