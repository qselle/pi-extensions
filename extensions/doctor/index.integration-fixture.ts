import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { plainText } from "../../lib/transcript/model.ts";
import type { Finding } from "./checks.ts";
const root = await mkdtemp(join(tmpdir(), "pi-doctor-ui-"));
process.env.PI_CODING_AGENT_DIR = root;
function harness(options?: Parameters<typeof extension>[1]) {
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const notices: string[] = [];
  const events: any[] = [];
  extension({ registerCommand: (name: string, value: any) => commands.set(name, value),
    on: (name: string, handler: Function) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    getCommands: () => [{ name: "doctor" }], getAllTools: () => [], getActiveTools: () => [],
    events: { emit: (name: string, data: unknown) => events.push({ name, data }) } } as never, options);
  return { doctor: commands.get("doctor"), notices, events,
    fire: (name: string) => { for (const handler of handlers.get(name) ?? []) handler(); },
    ctx: { cwd: root, mode: "json", ui: { notify: (text: string) => notices.push(text) } },
  };
}
async function waitFor(ready: () => boolean) {
  const until = Date.now() + 2000;
  while (!ready()) { assert(Date.now() < until, "timed out waiting for fixture UI"); await delay(1); }
}
const findings: Finding[] = [
  ...Array.from({ length: 18 }, (_, i): Finding => ({ id: `ok-${i}`, label: `Healthy ${i}`, status: "ok", detail: "Local check passed." })),
  { id: "pty", label: "Missing PTY helper", status: "warn", detail: "Interactive jobs are unavailable.", fix: "Reinstall package dependencies with install scripts enabled." },
  { id: "reader", label: "Missing reader", status: "warn", detail: "Page reader is unavailable." },
  { id: "optional", label: "Optional service", status: "off", detail: "Disabled." },
];
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} };
const keys = { matches: () => false, getKeys: () => [] };
try {
  const real = harness();
  await real.doctor.handler("text", real.ctx);
  assert(real.notices.at(-1)!.includes("Doctor"));
  assert(real.notices.at(-1)!.includes("no commands executed"));
  await real.doctor.handler("oops", real.ctx);
  assert.equal(real.notices.at(-1), "Usage: /doctor [text]");
  initTheme("dark", false);
  for (const boundary of ["session_start", "session_tree", "session_shutdown"]) {
    const h = harness({ diagnose: async () => findings });
    let closed = 0;
    await h.doctor.handler("", { ...h.ctx, mode: "tui", ui: { ...h.ctx.ui, custom: async (factory: Function) => {
      const view = factory(tui, theme, keys, () => closed++);
      const screen = view.render(80).map(plainText).join("\n");
      assert(screen.includes("2 items need attention"));
      assert(screen.includes("! Missing PTY helper"), "the first warning must be visible on opening");
      assert(!screen.includes("Transcript ·") && !screen.includes("following"));
      assert(!screen.includes("thinking"));
      assert(screen.includes("End bottom"));
      for (const width of [1, 20, 60, 80]) assert(view.render(width).every((line: string) => visibleWidth(line) <= width));
      h.fire(boundary);
      assert.deepEqual(view.render(80), []);
    } } });
    assert.equal(closed, 1);
    assert(h.events.some((entry) => entry.data.open === true));
    assert.equal(h.events.at(-1).data.open, false);
    for (const fail of [false, true]) {
      let resolve!: (value: Finding[]) => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<Finding[]>((yes, no) => { resolve = yes; reject = no; });
      let calls = 0;
      const slow = harness({ diagnose: () => calls++ === 0 ? pending : Promise.resolve(findings) });
      const old = slow.doctor.handler("text", slow.ctx);
      slow.fire(boundary);
      await slow.doctor.handler("text", slow.ctx);
      assert.equal(slow.notices.length, 1);
      if (fail) reject(new Error("stale fixture failure")); else resolve([]);
      await old;
      assert.equal(slow.notices.length, 1, "stale checks must not notify the replacement session");
    }
  }
  // A delayed panel factory cannot replace a newer panel or clear its guard.
  let calls = 0;
  const h = harness({ diagnose: async () => { calls++; return findings; } });
  const pending: Array<{ factory: Function; done: () => void }> = [];
  const ctx = { ...h.ctx, mode: "tui", ui: { ...h.ctx.ui, custom: (factory: Function) => new Promise<void>((done) => pending.push({ factory, done })) } };
  const old = h.doctor.handler("", ctx);
  await waitFor(() => pending.length === 1);
  h.fire("session_tree");
  const current = h.doctor.handler("", ctx);
  await waitFor(() => pending.length === 2);
  const newView = pending[1]!.factory(tui, theme, keys, pending[1]!.done);
  const staleView = pending[0]!.factory(tui, theme, keys, pending[0]!.done);
  assert.deepEqual(staleView.render(80), []);
  await old;
  await h.doctor.handler("text", h.ctx);
  assert.equal(calls, 2, "an older finally must not release the current command guard");
  assert(newView.render(80).map(plainText).join("\n").includes("2 items need attention"));
  newView.close();
  await current;
  console.log("doctor report, narrow UI and session cleanup verified");
} finally { await rm(root, { recursive: true, force: true }); }
