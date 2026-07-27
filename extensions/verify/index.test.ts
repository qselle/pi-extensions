import { describe, expect, test } from "bun:test";
import verifyExtension, { statusText } from "./index.ts";
import { emptyConfig, parseConfig, type VerifyConfig } from "./config.ts";
import type { ExecResult } from "./runner.ts";

function config(overrides: Partial<VerifyConfig> = {}): VerifyConfig {
  const parsed = parseConfig({
    checks: [{ name: "tests", match: "extensions/**/*.ts", command: "bun test {dir}" }],
  }, "global")!;
  return { ...parsed, ...overrides };
}

class MockPi {
  handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  commands = new Map<string, any>();
  execCalls: { command: string; args: string[] }[] = [];
  execResult: Partial<ExecResult> = { code: 0 };

  on(event: string, handler: (event: any, ctx: any) => any) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  async exec(command: string, args: string[]) {
    this.execCalls.push({ command, args });
    return { stdout: "", stderr: "", code: 0, ...this.execResult } as ExecResult;
  }
  emit(event: string, payload: any, ctx: any) {
    const results = (this.handlers.get(event) ?? []).map((handler) => handler(payload, ctx));
    return Promise.all(results);
  }
}

function createCtx(overrides: { trusted?: boolean; hasUI?: boolean; cwd?: string } = {}) {
  const notifications: { message: string; level?: string }[] = [];
  const statuses: { key: string; value: unknown }[] = [];
  return {
    notifications,
    statuses,
    ctx: {
      cwd: overrides.cwd ?? "/repo",
      mode: "tui",
      hasUI: overrides.hasUI ?? true,
      signal: undefined,
      isProjectTrusted: () => overrides.trusted ?? true,
      ui: {
        theme: { fg: (_c: string, v: string) => v },
        notify: (message: string, level?: string) => notifications.push({ message, level }),
        setStatus: (key: string, value: unknown) => statuses.push({ key, value }),
      },
    } as any,
  };
}

function setup(options: { config?: VerifyConfig; execResult?: Partial<ExecResult> } = {}) {
  const pi = new MockPi();
  if (options.execResult) pi.execResult = options.execResult;
  const loadCalls: any[] = [];
  verifyExtension(pi as any, {
    loadConfiguration: ((args: any) => { loadCalls.push(args); return options.config ?? config(); }) as any,
  });
  const created = createCtx();
  return { pi, loadCalls, ...created };
}

const editEvent = (overrides: any = {}) => ({
  toolName: "edit",
  input: { path: "/repo/extensions/verify/config.ts" },
  content: [{ type: "text", text: "Successfully replaced 1 block" }],
  isError: false,
  ...overrides,
});

describe("registration", () => {
  test("registers the command and lifecycle handlers", () => {
    const { pi } = setup();
    expect(pi.commands.has("verify")).toBe(true);
    for (const event of ["session_start", "session_tree", "turn_start", "tool_result", "session_shutdown"]) {
      expect(pi.handlers.has(event)).toBe(true);
    }
  });

  test("passes project trust into config loading", async () => {
    const { pi, loadCalls } = setup();
    const trusted = createCtx({ trusted: true });
    const untrusted = createCtx({ trusted: false });
    await pi.emit("session_start", {}, trusted.ctx);
    await pi.emit("session_start", {}, untrusted.ctx);
    expect(loadCalls[0].projectTrusted).toBe(true);
    expect(loadCalls[1].projectTrusted).toBe(false);
    expect(loadCalls[0].cwd).toBe("/repo");
  });
});

describe("tool_result gating", () => {
  async function run(event: any, options: Parameters<typeof setup>[0] = {}) {
    const harness = setup(options);
    await harness.pi.emit("session_start", {}, harness.ctx);
    const [result] = await harness.pi.emit("tool_result", event, harness.ctx);
    return { ...harness, result };
  }

  test("ignores tools other than edit and write", async () => {
    for (const toolName of ["read", "bash", "grep"]) {
      const { result, pi } = await run(editEvent({ toolName }));
      expect(result).toBeUndefined();
      expect(pi.execCalls).toHaveLength(0);
    }
  });

  test("ignores a failed write, since nothing new is on disk", async () => {
    const { result, pi } = await run(editEvent({ isError: true }));
    expect(result).toBeUndefined();
    expect(pi.execCalls).toHaveLength(0);
  });

  test("ignores an unmatched path", async () => {
    const { result, pi } = await run(editEvent({ input: { path: "/repo/README.md" } }));
    expect(result).toBeUndefined();
    expect(pi.execCalls).toHaveLength(0);
  });

  test("ignores a missing or blank path", async () => {
    expect((await run(editEvent({ input: {} }))).result).toBeUndefined();
    expect((await run(editEvent({ input: { path: "  " } }))).result).toBeUndefined();
  });

  test("does nothing when no checks are configured", async () => {
    const { result, pi } = await run(editEvent(), { config: emptyConfig() });
    expect(result).toBeUndefined();
    expect(pi.execCalls).toHaveLength(0);
  });

  test("does nothing when the config is disabled", async () => {
    const { result } = await run(editEvent(), { config: config({ enabled: false }) });
    expect(result).toBeUndefined();
  });

  test("handles the write tool too", async () => {
    const { pi } = await run(editEvent({ toolName: "write" }));
    expect(pi.execCalls).toHaveLength(1);
  });
});

describe("tool_result verification", () => {
  async function run(execResult: Partial<ExecResult>) {
    const harness = setup({ execResult });
    await harness.pi.emit("session_start", {}, harness.ctx);
    const [result] = await harness.pi.emit("tool_result", editEvent(), harness.ctx);
    return { ...harness, result };
  }

  test("passing check appends nothing", async () => {
    const { result, pi } = await run({ code: 0 });
    expect(result).toBeUndefined();
    expect(pi.execCalls[0]?.args[1]).toBe("bun test 'extensions/verify'");
  });

  test("failing check appends to the existing content and keeps isError unset", async () => {
    const { result } = await run({ code: 1, stdout: "1 failing" });
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toBe("Successfully replaced 1 block");
    expect(result.content[1].text).toContain("verify: tests failed (exit 1)");
    expect(result.content[1].text).toContain("1 failing");
    // The write applied, so flagging an error would make the agent redo it.
    expect(result.isError).toBeUndefined();
  });

  test("clears the running status afterwards", async () => {
    const { statuses } = await run({ code: 1, stdout: "boom" });
    expect(statuses[0]?.value).toContain("verifying tests");
    expect(statuses.at(-1)?.value).toBeUndefined();
  });

  test("caches within a turn and re-runs after turn_start", async () => {
    const harness = setup({ execResult: { code: 0 } });
    await harness.pi.emit("session_start", {}, harness.ctx);
    const event = editEvent();
    await harness.pi.emit("tool_result", event, harness.ctx);
    await harness.pi.emit("tool_result", event, harness.ctx);
    expect(harness.pi.execCalls).toHaveLength(1);
    await harness.pi.emit("turn_start", {}, harness.ctx);
    await harness.pi.emit("tool_result", event, harness.ctx);
    expect(harness.pi.execCalls).toHaveLength(2);
  });
});

describe("/verify", () => {
  async function setupCommand(options: Parameters<typeof setup>[0] = {}) {
    const harness = setup(options);
    await harness.pi.emit("session_start", {}, harness.ctx);
    return harness;
  }

  test("off disables verification, on re-enables it", async () => {
    const harness = await setupCommand();
    await harness.pi.commands.get("verify").handler("off", harness.ctx);
    await harness.pi.emit("tool_result", editEvent(), harness.ctx);
    expect(harness.pi.execCalls).toHaveLength(0);

    await harness.pi.commands.get("verify").handler("on", harness.ctx);
    await harness.pi.emit("tool_result", editEvent(), harness.ctx);
    expect(harness.pi.execCalls).toHaveLength(1);
  });

  test("status reports config, checks, and the last result", async () => {
    const harness = await setupCommand({ execResult: { code: 1, stdout: "boom" } });
    await harness.pi.emit("tool_result", editEvent(), harness.ctx);
    await harness.pi.commands.get("verify").handler("status", harness.ctx);
    const message = harness.notifications.at(-1)!.message;
    expect(message).toContain("verification: on");
    expect(message).toContain("tests: extensions/**/*.ts -> bun test {dir}");
    expect(message).toContain("last: tests failed (exit 1)");
  });

  test("run executes a matching check and reports the result", async () => {
    const harness = await setupCommand({ execResult: { code: 0 } });
    await harness.pi.commands.get("verify").handler("run extensions/verify/config.ts", harness.ctx);
    expect(harness.pi.execCalls).toHaveLength(1);
    expect(harness.notifications.at(-1)?.level).toBe("info");
    expect(harness.notifications.at(-1)?.message).toContain("tests passed");
  });

  test("run reports a failure as an error", async () => {
    const harness = await setupCommand({ execResult: { code: 1, stdout: "nope" } });
    await harness.pi.commands.get("verify").handler("run extensions/verify/config.ts", harness.ctx);
    expect(harness.notifications.at(-1)?.level).toBe("error");
  });

  test("run needs a path and reports an unmatched one", async () => {
    const harness = await setupCommand();
    await harness.pi.commands.get("verify").handler("run", harness.ctx);
    expect(harness.notifications.at(-1)).toEqual({ message: "Usage: /verify run <path>", level: "error" });
    await harness.pi.commands.get("verify").handler("run README.md", harness.ctx);
    expect(harness.notifications.at(-1)?.message).toContain("No check matches");
  });

  test("rejects an unknown subcommand", async () => {
    const harness = await setupCommand();
    await harness.pi.commands.get("verify").handler("bogus", harness.ctx);
    expect(harness.notifications.at(-1)?.level).toBe("error");
  });

  test("completes subcommands", async () => {
    const harness = await setupCommand();
    const completions = harness.pi.commands.get("verify").getArgumentCompletions("o");
    expect(completions.map((item: any) => item.value)).toEqual(["on", "off"]);
    expect(harness.pi.commands.get("verify").getArgumentCompletions("zz")).toBeNull();
  });
});

describe("statusText", () => {
  test("warns when a project config was ignored for trust", () => {
    const text = statusText({ ...emptyConfig(), untrustedProjectConfig: true }, true);
    expect(text).toContain("not trusted");
    expect(text).toContain("no checks configured");
  });
  test("reports off when the session toggle is off", () => {
    expect(statusText(config(), false)).toContain("verification: off");
  });
});
