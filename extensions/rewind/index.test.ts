import { expect, test } from "bun:test";
import extension from "./index.ts";

function harness() {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const events: unknown[] = [];
  let stale = false;
  let idle = true;
  let pending = false;
  let leaf = "b";
  let choice: string | null = "#1 · first";
  let custom: (() => Promise<string | null>) | undefined;
  const notices: string[] = [];
  const edits: string[] = [];
  const forks: Array<{ id: string; position: string }> = [];
  const assertFresh = () => { if (stale) throw new Error("stale API access"); };
  extension({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (name: string, value: unknown) => commands.set(name, value),
    events: { emit: (...args: unknown[]) => { assertFresh(); events.push(args); } },
  } as never);
  const ctx = {
    mode: "tui", isIdle: () => { assertFresh(); return idle; }, hasPendingMessages: () => pending,
    sessionManager: {
      getBranch: () => ["first", "second"].map((text, i) => ({ id: i ? "b" : "a", type: "message", message: { role: "user", content: text } })),
      getLeafId: () => leaf,
    },
    ui: { notify: (text: string) => { assertFresh(); notices.push(text); }, custom: async () => custom ? custom() : choice },
    fork: async (id: string, options: any) => {
      forks.push({ id, position: options.position });
      stale = true;
      await options.withSession({ ui: { setEditorText: (text: string) => edits.push(text), notify: (text: string) => notices.push(text) } });
      return { cancelled: false };
    },
  };
  return { commands, ctx, events, notices, edits, forks, handlers,
    setIdle: (v: boolean) => { idle = v; }, setPending: (v: boolean) => { pending = v; },
    setChoice: (v: string | null) => { choice = v; }, setLeaf: (v: string) => { leaf = v; },
    setCustom: (fn: () => Promise<string | null>) => { custom = fn; },
    run: (args = "", name = "rewind") => commands.get(name).handler(args, ctx),
  };
}

test("rewind closes the modal before forking and uses only the fresh session to restore text", async () => {
  const h = harness();
  await h.run();
  expect(h.forks).toEqual([{ id: "a", position: "before" }]);
  expect(h.edits).toEqual(["first"]);
  expect(h.events).toEqual([["workflow-overlay:modal", { id: "rewind", open: true }], ["workflow-overlay:modal", { id: "rewind", open: false }]]);
});

test("last and undo target the newest prompt without a picker", async () => {
  const h = harness();
  await h.run("last", "undo");
  expect(h.forks[0]!.id).toBe("b");
  expect(h.edits).toEqual(["second"]);
  expect(h.events).toEqual([]);
});

test("cancel, busy, pending and non-interactive sessions leave history unchanged", async () => {
  for (const state of ["cancel", "busy", "pending", "rpc"]) {
    const h = harness();
    if (state === "cancel") h.setChoice(null);
    if (state === "busy") h.setIdle(false);
    if (state === "pending") h.setPending(true);
    if (state === "rpc") h.ctx.mode = "rpc";
    await h.run();
    expect(h.forks).toEqual([]);
    expect(h.edits).toEqual([]);
  }
});

test("a changed branch invalidates the selection", async () => {
  const h = harness();
  h.setCustom(async () => { h.setLeaf("changed"); return "#1 · first"; });
  await h.run();
  expect(h.forks).toEqual([]);
  expect(h.notices.at(-1)).toContain("session changed");
});

test("a replaced session invalidates a pending picker without touching the old API", async () => {
  const h = harness();
  h.setCustom(async () => { h.handlers.get("session_shutdown")!(); return "#1 · first"; });
  await h.run();
  expect(h.forks).toEqual([]);
  expect(h.events).toHaveLength(1);
});

test("host fork cancellation does not restore text", async () => {
  const h = harness();
  h.ctx.fork = async () => ({ cancelled: true });
  await h.run("last");
  expect(h.edits).toEqual([]);
});
