import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import sessionTitleExtension from "./index.ts";
import type { HerdrMethod, HerdrRequest } from "./herdr-client.ts";

const environment = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr-test.sock", HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "stale" };

function setup(options: { label?: string; mode?: string; env?: NodeJS.ProcessEnv; enabled?: boolean; entries?: any[] } = {}) {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const entries = options.entries ?? [];
  const notices: string[] = [];
  const calls: { method: HerdrMethod; params: Record<string, string>; signal: AbortSignal }[] = [];
  const writes: { tab_id: string; label: string }[] = [];
  const pane = { pane_id: "w1:p2", tab_id: "w1:t3", terminal_id: "terminal-2" };
  const tab = { tab_id: "w1:t3", label: options.label ?? "", pane_count: 1 };
  let name: string | undefined = "First Title";
  let intercept: ((method: HerdrMethod, signal: AbortSignal) => Promise<void>) | undefined;
  let modelCalls = 0;
  const ctx: any = {
    mode: options.mode ?? "tui",
    sessionManager: { getEntries: () => entries, getBranch: () => [] },
    ui: { notify: (text: string) => notices.push(text) },
  };
  const emit = async (event: string, data = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(data, ctx);
  };
  const request: HerdrRequest = async (_path, method, params, signal) => {
    calls.push({ method, params, signal });
    await intercept?.(method, signal);
    if (signal.aborted) throw new Error("cancelled");
    if (method === "pane.get") return { type: "pane_info", pane: { ...pane } };
    if (method === "tab.get") return { type: "tab_info", tab: { ...tab } };
    writes.push({ tab_id: params.tab_id!, label: params.label! });
    tab.label = params.label!;
    return { type: "tab_info", tab: { ...tab } };
  };
  const pi: any = {
    on: (event: string, handler: Function) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (command: string, spec: any) => commands.set(command, spec),
    getSessionName: () => name,
    setSessionName: (value: string) => { name = value; void emit("session_info_changed", { name }); },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    events: { emit: () => {} },
  };
  sessionTitleExtension(pi, {
    config: { enabled: false, tabLink: options.enabled },
    tabLink: { env: options.env ?? environment, request },
    request: async () => { modelCalls += 1; return { title: "Generated Title" }; },
  });
  const command = (text: string) => commands.get("title").handler(text, ctx);
  const idle = () => command("tab status");
  const rename = async (value: string | undefined) => { name = value; await emit("session_info_changed", { name }); };
  return {
    pane, tab, entries, calls, writes, notices, ctx, commands, emit, command, idle, rename,
    modelCalls: () => modelCalls,
    intercept: (fn?: typeof intercept) => { intercept = fn; },
    start: async () => { await emit("session_start"); await idle(); },
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("Tab link", () => {
  test("uses the live pane's tab, follows all Pi title changes, and deduplicates writes", async () => {
    const h = setup();
    await h.start();
    expect(h.writes).toEqual([{ tab_id: "w1:t3", label: "First Title" }]);
    await h.emit("agent_start");
    await h.idle();
    expect(h.writes).toHaveLength(1);
    await h.command("set Release: v2 / APIs");
    await h.idle();
    expect(h.tab.label).toBe("Release: v2 / APIs");
    await h.commands.get("rename").handler("Our Manual Name", h.ctx);
    await h.idle();
    expect(h.tab.label).toBe("Our Manual Name");
    await h.rename("Title From Another Extension");
    await h.idle();
    expect(h.tab.label).toBe("Title From Another Extension");
    expect(h.modelCalls()).toBe(0);
    expect(h.calls.every((call) => call.params.tab_id !== "stale")).toBe(true);
  });

  test("automatically claims Herdr's default ordinal label", async () => {
    const h = setup({ label: "3" });
    await h.start();
    expect(h.tab.label).toBe("First Title");
  });

  test("migrates an old paused state when the label is the tab's default ordinal", async () => {
    const key = createHash("sha256")
      .update(`${environment.HERDR_SOCKET_PATH}\0terminal-2\0w1:t3`)
      .digest("hex");
    const h = setup({
      label: "3",
      entries: [{ type: "custom", customType: "session-title:tab-link", data: { version: 1, paused: key } }],
    });
    await h.start();
    expect(h.tab.label).toBe("First Title");
    expect(h.entries.at(-1)?.data.owner?.label).toBe("First Title");
  });

  test.each(["My Workspace", "1", "First Title"])("preserves an unverified label %s until explicitly linked", async (label) => {
    const h = setup({ label });
    await h.start();
    expect(h.writes).toHaveLength(0);
    expect(h.notices.at(-1)).toContain("preserving");
    await h.command("tab link");
    await h.rename("Second Title");
    await h.idle();
    expect(h.tab.label).toBe("Second Title");
  });

  test.each(["Hand-written label", ""])("yields to an external rename, including clearing to %s", async (label) => {
    const h = setup();
    await h.start();
    h.tab.label = label;
    await h.rename("Second Title");
    await h.idle();
    await h.rename("Third Title");
    await h.idle();
    expect(h.tab.label).toBe(label);
    expect(h.writes).toHaveLength(1);
    await h.command("tab link");
    expect(h.tab.label).toBe("Third Title");
  });

  test("persists ownership across reload but never transfers it to a different terminal", async () => {
    const first = setup();
    await first.start();
    const resumed = setup({ label: first.tab.label, entries: structuredClone(first.entries) });
    await resumed.start();
    await resumed.rename("Resumed Title");
    await resumed.idle();
    expect(resumed.tab.label).toBe("Resumed Title");
    const other = setup({ label: first.tab.label, entries: structuredClone(first.entries) });
    other.pane.terminal_id = "another-terminal";
    await other.start();
    await other.rename("Wrong Pane");
    await other.idle();
    expect(other.writes).toHaveLength(0);
    expect(JSON.stringify(first.entries)).not.toContain(environment.HERDR_SOCKET_PATH);
  });

  test("carries ownership into a new session and records it even when the name is identical", async () => {
    const h = setup();
    await h.start();
    h.entries.length = 0;
    await h.start();
    expect(h.entries).toHaveLength(1);
    await h.rename("New Session");
    await h.idle();
    expect(h.tab.label).toBe("New Session");
  });

  test("the current link survives resuming a session with an older saved label", async () => {
    const h = setup();
    await h.start();
    const olderEntries = structuredClone(h.entries);
    h.entries.length = 0;
    await h.start();
    await h.rename("Second Session");
    await h.idle();
    h.entries.splice(0, h.entries.length, ...olderEntries);
    await h.emit("session_start", { reason: "resume" });
    await h.rename("First Session Resumed");
    await h.idle();
    expect(h.tab.label).toBe("First Session Resumed");
    // A human can even pick a label that matches an older saved ownership entry.
    h.tab.label = "First Title";
    h.entries.splice(0, h.entries.length, ...olderEntries);
    await h.start();
    expect(h.tab.label).toBe("First Title");
    h.entries.splice(0, h.entries.length, ...olderEntries);
    await h.start();
    expect(h.tab.label).toBe("First Title");
  });

  test.each(["pane", "label", "pane count"])("an unsupported %s response never authorizes a rename", async (field) => {
    const h = setup();
    if (field === "pane") h.pane.pane_id = "unexpected";
    if (field === "label") (h.tab as any).label = null;
    if (field === "pane count") (h.tab as any).pane_count = undefined;
    await h.start();
    await h.command("tab link");
    expect(h.writes).toHaveLength(0);
    expect(h.notices.at(-1)).toContain("Unsupported");
  });

  test("off survives reload; auto resumes only a still-owned label", async () => {
    const h = setup();
    await h.start();
    await h.command("tab off");
    await h.start();
    await h.rename("Deferred Name");
    await h.idle();
    expect(h.tab.label).toBe("First Title");
    await h.command("tab auto");
    expect(h.tab.label).toBe("Deferred Name");
    await h.command("tab off");
    h.tab.label = "Manual Label";
    await h.command("tab auto");
    expect(h.tab.label).toBe("Manual Label");
  });

  test("split tabs are left alone even when explicitly linking", async () => {
    const h = setup();
    h.tab.pane_count = 2;
    await h.start();
    await h.command("tab link");
    expect(h.writes).toHaveLength(0);
    expect(h.notices.at(-1)).toContain("split tabs");
    h.tab.pane_count = 1;
    await h.emit("agent_start");
    await h.idle();
    expect(h.tab.label).toBe("First Title");
  });

  test("moving to a labelled tab never transfers old ownership", async () => {
    const h = setup();
    await h.start();
    h.pane.tab_id = h.tab.tab_id = "w1:t4";
    h.tab.label = "Destination";
    await h.rename("Moved Session");
    await h.idle();
    expect(h.tab.label).toBe("Destination");
    expect(h.writes).toHaveLength(1);
  });

  test("detects a pane move between inspection and rename", async () => {
    const h = setup();
    let reads = 0;
    h.intercept(async (method) => { if (method === "pane.get" && ++reads === 2) h.pane.tab_id = "w1:t9"; });
    await h.start();
    expect(h.writes).toHaveLength(0);
    expect(h.notices.at(-1)).toContain("pane moved");
  });

  test("coalesces rapid updates and preserves an explicit link while reads are pending", async () => {
    const h = setup({ label: "Manual Label" });
    await h.start();
    const entered = deferred();
    const hold = deferred();
    h.intercept(async () => { entered.release(); await hold.promise; });
    const linking = h.command("tab link");
    await entered.promise;
    await h.rename("Middle Title");
    await h.rename("Newest Title");
    hold.release();
    await linking;
    expect(h.writes).toEqual([{ tab_id: "w1:t3", label: "Newest Title" }]);
  });

  test("serializes writes so a slow old acknowledgement cannot win", async () => {
    const h = setup();
    const entered = deferred();
    const hold = deferred();
    h.intercept(async (method) => { if (method === "tab.rename") { entered.release(); await hold.promise; } });
    await h.emit("session_start");
    await entered.promise;
    await h.rename("Newest Title");
    hold.release();
    await h.idle();
    expect(h.writes.map((write) => write.label)).toEqual(["First Title", "Newest Title"]);
    expect(h.tab.label).toBe("Newest Title");
  });

  test.each(["session_shutdown", "session_start"])("cancels stale work on %s", async (event) => {
    const h = setup();
    const entered = deferred();
    const hold = deferred();
    h.intercept(async () => { entered.release(); await hold.promise; });
    await h.emit("session_start");
    await entered.promise;
    const oldSignal = h.calls[0]!.signal;
    await h.rename(undefined);
    await h.emit(event);
    hold.release();
    await h.idle();
    expect(oldSignal.aborted).toBe(true);
    expect(h.writes).toHaveLength(0);
  });

  test("clearing the Pi name invalidates a pending rename", async () => {
    const h = setup();
    const entered = deferred();
    const hold = deferred();
    h.intercept(async () => { entered.release(); await hold.promise; });
    await h.emit("session_start");
    await entered.promise;
    await h.rename(undefined);
    hold.release();
    await h.idle();
    expect(h.writes).toHaveLength(0);
  });

  test("unavailable Herdr stays quiet and retries on the next turn", async () => {
    const h = setup();
    h.intercept(async () => { throw new Error("Herdr socket is unavailable"); });
    await h.emit("session_start");
    await h.idle();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("unavailable");
    h.intercept();
    await h.emit("agent_start");
    await h.idle();
    expect(h.tab.label).toBe("First Title");
  });

  test.each([
    { mode: "print" }, { mode: "rpc" }, { env: {} },
    { env: { ...environment, PI_SUBAGENT_CHILD: "1" } },
    { env: { ...environment, HERDR_PANE_ID: undefined, HERDR_ACTIVE_PANE_ID: "w1:p2" } },
    { enabled: false },
  ])("does no socket work when unavailable or disabled: %j", async (options) => {
    const h = setup(options);
    await h.start();
    await h.rename("Ignored Name");
    await h.idle();
    expect(h.calls).toHaveLength(0);
  });

  test("sanitizes external title events and offers discoverable commands", async () => {
    const h = setup();
    await h.start();
    await h.rename("\x1b[31mRelease\x1b[0m\nReady\x00");
    await h.idle();
    expect(h.tab.label).toBe("Release Ready");
    await h.command("tab something");
    expect(h.notices.at(-1)).toContain("Usage:");
    expect(h.commands.get("title").getArgumentCompletions("tab ").map((item: any) => item.value))
      .toEqual(["tab status", "tab link", "tab auto", "tab off"]);
    await h.rename(undefined);
    await h.command("tab link");
    expect(h.notices.at(-1)).toContain("Name this Pi session first");
  });
});
