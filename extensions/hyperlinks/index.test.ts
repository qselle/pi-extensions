import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hyperlinksExtension, { loadMode } from "./index.ts";
import { getHyperlinkMode, setHyperlinkMode } from "./link.ts";

afterEach(() => setHyperlinkMode("auto"));

class MockPi {
  commands = new Map<string, any>();
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  on() {}
}

function createCtx(cwd = "/repo") {
  const notifications: { message: string; level?: string }[] = [];
  return {
    notifications,
    ctx: { cwd, mode: "tui", ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) } } as any,
  };
}

function configDir(contents?: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "hyperlinks-"));
  if (contents !== undefined) writeFileSync(join(directory, "hyperlinks.json"), JSON.stringify(contents));
  return directory;
}

describe("loadMode", () => {
  test("returns undefined without a config file", () => {
    expect(loadMode(configDir())).toBeUndefined();
  });
  test("reads a valid mode", () => {
    expect(loadMode(configDir({ mode: "never" }))).toBe("never");
    expect(loadMode(configDir({ mode: "always" }))).toBe("always");
  });
  test("ignores junk and malformed json", () => {
    expect(loadMode(configDir({ mode: "sometimes" }))).toBeUndefined();
    const directory = mkdtempSync(join(tmpdir(), "hyperlinks-"));
    writeFileSync(join(directory, "hyperlinks.json"), "{oops");
    expect(loadMode(directory)).toBeUndefined();
  });
});

describe("registration", () => {
  test("registers both commands", () => {
    const pi = new MockPi();
    hyperlinksExtension(pi as any, { configDirectory: configDir() });
    expect([...pi.commands.keys()].sort()).toEqual(["hyperlinks", "open-path"]);
  });

  test("applies the configured mode at load", () => {
    const pi = new MockPi();
    hyperlinksExtension(pi as any, { configDirectory: configDir({ mode: "never" }) });
    expect(getHyperlinkMode()).toBe("never");
  });

  test("leaves the mode alone when unconfigured", () => {
    setHyperlinkMode("always");
    const pi = new MockPi();
    hyperlinksExtension(pi as any, { configDirectory: configDir() });
    expect(getHyperlinkMode()).toBe("always");
  });
});

describe("/hyperlinks", () => {
  function setup() {
    const pi = new MockPi();
    hyperlinksExtension(pi as any, { configDirectory: configDir() });
    return { pi, ...createCtx() };
  }

  test("sets the mode", async () => {
    const { pi, ctx, notifications } = setup();
    await pi.commands.get("hyperlinks").handler("never", ctx);
    expect(getHyperlinkMode()).toBe("never");
    expect(notifications[0]?.message).toContain("never");
  });

  test("reports status with no argument", async () => {
    const { pi, ctx, notifications } = setup();
    await pi.commands.get("hyperlinks").handler("", ctx);
    expect(notifications[0]?.message).toContain("mode:");
    expect(notifications[0]?.message).toContain("active:");
  });

  test("rejects an unknown argument", async () => {
    const { pi, ctx, notifications } = setup();
    await pi.commands.get("hyperlinks").handler("bogus", ctx);
    expect(notifications[0]).toEqual({ message: "Usage: /hyperlinks [auto|always|never]", level: "error" });
  });

  test("completes mode names", () => {
    const { pi } = setup();
    const completions = pi.commands.get("hyperlinks").getArgumentCompletions("a");
    expect(completions.map((item: any) => item.value)).toEqual(["auto", "always"]);
    expect(pi.commands.get("hyperlinks").getArgumentCompletions("zz")).toBeNull();
  });
});

describe("/open-path", () => {
  function setup(cwd: string) {
    const pi = new MockPi();
    hyperlinksExtension(pi as any, { configDirectory: configDir() });
    return { pi, ...createCtx(cwd) };
  }

  test("requires an argument", async () => {
    const { pi, ctx, notifications } = setup("/repo");
    await pi.commands.get("open-path").handler("  ", ctx);
    expect(notifications[0]).toEqual({ message: "Usage: /open-path <path>", level: "error" });
  });

  test("rejects a missing path", async () => {
    const { pi, ctx, notifications } = setup("/repo");
    await pi.commands.get("open-path").handler("nope-does-not-exist.ts", ctx);
    expect(notifications[0]?.level).toBe("error");
    expect(notifications[0]?.message).toContain("does not exist");
  });

  test("prints a link for an existing path", async () => {
    setHyperlinkMode("always");
    const directory = mkdtempSync(join(tmpdir(), "hyperlinks-open-"));
    writeFileSync(join(directory, "a.ts"), "x");
    const { pi, ctx, notifications } = setup(directory);
    await pi.commands.get("open-path").handler("a.ts", ctx);
    expect(notifications[0]?.level).toBe("info");
    expect(notifications[0]?.message).toContain("\x1b]8;;");
    expect(notifications[0]?.message).toContain("a.ts");
  });

  test("prints a plain URI when hyperlinks are off", async () => {
    setHyperlinkMode("never");
    const directory = mkdtempSync(join(tmpdir(), "hyperlinks-open-"));
    writeFileSync(join(directory, "a.ts"), "x");
    const { pi, ctx, notifications } = setup(directory);
    await pi.commands.get("open-path").handler("a.ts", ctx);
    expect(notifications[0]?.message).not.toContain("\x1b]8;;");
    expect(notifications[0]?.message).toContain("file://");
  });
});
