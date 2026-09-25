import { expect, test } from "bun:test";
import { ENTRY, TerminalProcesses, type Context } from "./service.ts";
import { fakeHerdr } from "./socket-fixture.ts";

async function fixture() {
  const wire = await fakeHerdr(), entries: any[] = [];
  let sessionId = "owner-session", saved = true, failPersistence = false;
  const ctx: Context = { mode: "tui", cwd: wire.root, sessionManager: {
    getSessionId: () => sessionId, getSessionFile: () => saved ? wire.sessionFile : undefined, getEntries: () => entries,
  } };
  const create = () => new TerminalProcesses((data) => {
    if (failPersistence) throw new Error("Synthetic persistence failure");
    entries.push({ type: "custom", customType: ENTRY, data: structuredClone(data) });
  }, { env: wire.env });
  const service = create(); service.restore(ctx);
  return { ...wire, entries, ctx, service, create, setSession: (value: string) => { sessionId = value; },
    unsaved: () => { saved = false; }, failPersistence: () => { failPersistence = true; } };
}

test("exact commands use one atomic submission, explicit sibling target and no focus changes", async () => {
  const f = await fixture();
  try {
    const command = "  printf '%s\\n' '$HOME'\ncat <<'EOF'\nliteral `text`\nEOF\n";
    const started = await f.service.execute({ action: "start", command, label: "Watch tests" }, f.ctx);
    expect(f.requests.find((r) => r.method === "pane.split")?.params).toEqual({ target_pane_id: "w1:p1", direction: "right", cwd: f.root, focus: false });
    expect(f.requests.filter((r) => r.method === "pane.send_input").map((r) => r.params)).toEqual([{ pane_id: "w1:p2", text: command, keys: ["Enter"] }]);
    expect(f.entries.map((e) => e.data.stage)).toEqual(["created", "unconfirmed", "submitted"]);
    expect(JSON.stringify(started)).not.toContain(command);
    await f.service.execute({ action: "start", command: "watch tests" }, f.ctx);
    expect(f.requests.filter((r) => r.method === "pane.split").at(-1)?.params.direction).toBe("down");
    await f.service.execute({ action: "start", command: "watch logs", direction: "down" }, f.ctx);
    await f.service.execute({ action: "start", command: "watch logs" }, f.ctx);
    expect(f.requests.filter((r) => r.method === "pane.split").at(-1)?.params.direction).toBe("right");
    f.service.stop();
    expect(f.requests.some((r) => /close|focus|stop/.test(r.method))).toBe(false);
  } finally { await f.close(); }
});

test("narrow panes split below; input and process results do not echo input or argv", async () => {
  const f = await fixture();
  try {
    f.state.width = 70; f.state.height = 50;
    await f.service.execute({ action: "start", command: "interactive" }, f.ctx);
    expect(f.requests.find((r) => r.method === "pane.split")?.params.direction).toBe("down");
    const result = await f.service.execute({ action: "input", pane_id: "w1:p2", text: "PRIVATE input", press_enter: false }, f.ctx);
    expect(f.requests.at(-1)?.params).toEqual({ pane_id: "w1:p2", text: "PRIVATE input", keys: [] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    const status = await f.service.execute({ action: "status", pane_id: "w1:p2" }, f.ctx);
    expect(status.content[0].text).toBe("node (PID 123)");
    expect(JSON.stringify(status)).not.toContain("SECRET");
    f.intercept((r, socket) => {
      if (r.method !== "pane.process_info") return false;
      socket.end(JSON.stringify({ id: r.id, result: { type: "pane_process_info", process_info: { pane_id: "w1:p2" } } }) + "\n"); return true;
    });
    expect((await f.service.execute({ action: "status", pane_id: "w1:p2" }, f.ctx)).content[0].text).toContain("No foreground process");
    await f.service.execute({ action: "input", pane_id: "w1:p2", press_enter: true }, f.ctx);
    expect(f.requests.at(-1)?.params).toEqual({ pane_id: "w1:p2", text: "", keys: ["Enter"] });
    await f.service.execute({ action: "interrupt", pane_id: "w1:p2" }, f.ctx);
    expect(f.requests.at(-1)?.params).toEqual({ pane_id: "w1:p2", text: "", keys: ["ctrl+c"] });
  } finally { await f.close(); }
});

test("read uses native recent_unwrapped with visible fallback and bounded plain output", async () => {
  const f = await fixture();
  try {
    await f.service.execute({ action: "start", command: "watch" }, f.ctx);
    f.state.recent = "";
    f.state.visible = "\x1b]52;c;private\x07\x1b[31mred\x1b[0m\n" + "x".repeat(60_000);
    const result = await f.service.execute({ action: "read", pane_id: "w1:p2", lines: 2 }, f.ctx);
    expect(f.requests.filter((r) => r.method === "pane.read").map((r) => r.params.source)).toEqual(["recent_unwrapped", "visible"]);
    expect(result.details.truncated).toBe(true);
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(50 * 1024);
    expect(result.content[0].text).not.toContain("\x1b");
    expect(result.content[0].text).not.toContain("private");
  } finally { await f.close(); }
});

test("ownership survives reload and tree changes, never crosses forks or reused terminals", async () => {
  const f = await fixture();
  try {
    await f.service.execute({ action: "start", command: "watch" }, f.ctx);
    f.service.stop();
    const resumed = f.create(); resumed.restore(f.ctx);
    await resumed.execute({ action: "status", pane_id: "w1:p2" }, f.ctx);
    resumed.restore(f.ctx);
    expect((await resumed.execute({ action: "list" }, f.ctx)).content[0].text).toContain("w1:p2");
    f.panes.set("w1:p2", { ...f.panes.get("w1:p2"), terminal_id: "recycled-terminal" });
    await expect(resumed.execute({ action: "input", pane_id: "w1:p2", text: "do not send" }, f.ctx)).rejects.toThrow("identity changed");
    f.setSession("fork-session"); resumed.restore(f.ctx);
    expect((await resumed.execute({ action: "list" }, f.ctx)).content[0].text).toContain("No terminal panes");
    await expect(resumed.execute({ action: "interrupt", pane_id: "w1:p2" }, f.ctx)).rejects.toThrow("this Pi session");
    expect(f.requests.filter((r) => r.method === "pane.send_input")).toHaveLength(1);
  } finally { await f.close(); }
});

test("stale lifecycle and cancellation never dispatch later input or persist in a new session", async () => {
  const f = await fixture();
  try {
    await expect(f.service.execute({ action: "start", command: "never" }, f.ctx, AbortSignal.abort())).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
    f.intercept((request) => {
      if (request.method === "pane.get") { f.setSession("other-session"); f.service.restore(f.ctx); }
      return false;
    });
    await expect(f.service.execute({ action: "start", command: "never" }, f.ctx)).rejects.toThrow();
    expect(f.requests.some((r) => r.method === "pane.split")).toBe(false);
    expect(f.entries).toHaveLength(0);
  } finally { await f.close(); }
});

test("ambiguous input acknowledgement retains ownership without retries; persistence failure prevents launch", async () => {
  const f = await fixture();
  try {
    f.intercept((request, socket) => {
      if (request.method !== "pane.send_input") return false;
      socket.destroy(); return true;
    });
    await expect(f.service.execute({ action: "start", command: "one shot" }, f.ctx)).rejects.toThrow("acknowledging");
    expect(f.entries.at(-1).data.stage).toBe("unconfirmed");
    expect(f.requests.filter((r) => r.method === "pane.send_input")).toHaveLength(1);
    f.service.restore(f.ctx);
    expect((await f.service.execute({ action: "list" }, f.ctx)).content[0].text).toContain("launch unconfirmed");
    f.intercept(); f.failPersistence();
    await expect(f.service.execute({ action: "start", command: "never" }, f.ctx)).rejects.toThrow("persistence");
    expect(f.requests.filter((r) => r.method === "pane.send_input")).toHaveLength(1);
  } finally { await f.close(); }
});

test("inactive and unsaved sessions cannot create panes; foreign socket records cannot control panes", async () => {
  const f = await fixture();
  try {
    f.unsaved();
    await expect(f.service.execute({ action: "start", command: "watch" }, f.ctx)).rejects.toThrow("saved Pi session");
    expect(f.requests).toHaveLength(0);
    expect(f.service.available({ ...f.ctx, mode: "rpc" })).toBe(false);
    const isolated = new TerminalProcesses(() => {}, { env: { ...f.env, PI_SUBAGENT_CHILD: "1" } });
    expect(isolated.available(f.ctx)).toBe(false);
    f.entries.push({ type: "custom", customType: ENTRY, data: { version: 1, sessionId: "owner-session", socketKey: "0".repeat(64), paneId: "w1:p2", terminalId: "terminal-2", label: "Old", direction: "right", stage: "submitted" } });
    f.service.restore(f.ctx);
    await expect(f.service.execute({ action: "interrupt", pane_id: "w1:p2" }, f.ctx)).rejects.toThrow("different Herdr server");
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});
