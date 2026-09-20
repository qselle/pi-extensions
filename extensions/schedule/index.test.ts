import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import scheduleExtension from "./index.ts";
import { createReminder } from "./schedule.ts";
import { emptyScheduleStore, loadScheduleStore, saveScheduleStore, scheduleStorePath } from "./store.ts";

type Handler = (event: any, ctx: any) => any;
class MockPi {
  events = { emit() {} };
  handlers = new Map<string, Handler[]>(); commands = new Map<string, any>(); tools = new Map<string, any>(); sent: any[] = [];
  on(event: string, handler: Handler) { const list = this.handlers.get(event) ?? []; list.push(handler); this.handlers.set(event, list); }
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  registerTool(tool: any) { this.tools.set(tool.name, tool); }
  sendMessage(message: unknown, options: unknown) { this.sent.push({ message, options }); }
  async emit(event: string, payload: unknown, ctx: any) { const out = []; for (const handler of this.handlers.get(event) ?? []) out.push(await handler(payload, ctx)); return out; }
}
function context(project: string) {
  const notifications: string[] = [];
  const statuses = new Map<string, string>();
  const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
  return { cwd: project, mode: "tui", isIdle: () => true, hasPendingMessages: () => false,
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: (key: string, text: string | undefined) => {
        statusUpdates.push({ key, text });
        if (text === undefined) statuses.delete(key); else statuses.set(key, text);
      },
    }, notifications, statuses, statusUpdates };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for scheduled work.");
    await Bun.sleep(10);
  }
}

test("persists reminders outside the transcript and exposes management", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-schedule-index-"));
  try {
    const project = join(root, "project"); const agentDir = join(root, "agent");
    const pi = new MockPi(); const ctx = context(project);
    scheduleExtension(pi as any, { agentDir });
    await pi.emit("session_start", {}, ctx);
    await pi.commands.get("remind").handler("in 30m -- check the deployment", ctx);
    const path = scheduleStorePath(agentDir, project);
    const stored = loadScheduleStore(path, project);
    expect(stored.tasks[0]).toMatchObject({ kind: "reminder", prompt: "check the deployment", status: "active" });
    await pi.commands.get("schedule").handler("status", ctx);
    expect(ctx.notifications.at(-1)).toContain("Schedule queue: owner");
    await pi.commands.get("schedule").handler("stop all", ctx);
    await pi.emit("session_shutdown", {}, ctx);
    await pi.emit("agent_settled", {}, ctx);
    await Bun.sleep(20);
    const afterShutdown = await pi.tools.get("get_schedules").execute();
    expect(afterShutdown.details.writable).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retries overdue durable work and completes only after the turn settles", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-schedule-due-"));
  try {
    const project = join(root, "project"); const agentDir = join(root, "agent");
    const path = scheduleStorePath(agentDir, project);
    const store = emptyScheduleStore(project);
    store.tasks.push(createReminder({ prompt: "inspect the overnight build", runAt: Date.now() - 1_000 }, Date.now() - 60_000, "due"));
    await saveScheduleStore(path, store);
    const pi = new MockPi(); const ctx = context(project);
    scheduleExtension(pi as any, { agentDir });
    await pi.emit("session_start", {}, ctx);
    await waitFor(() => pi.sent.length === 1);
    expect(pi.sent).toHaveLength(1);
    expect(loadScheduleStore(path, project).tasks[0].pendingDeliveryAt).toBeDefined();
    await pi.emit("agent_start", {}, ctx);
    const [transformed] = await pi.emit("context", { messages: [{ role: "custom", ...pi.sent[0].message }] }, ctx);
    expect(transformed.messages[0].content).toContain("inspect the overnight build");
    expect(transformed.messages[0].content).toContain("does not authorize destructive actions");
    await pi.emit("agent_settled", {}, ctx);
    const completed = loadScheduleStore(path, project).tasks[0];
    expect(completed).toMatchObject({ status: "completed", runs: 1 });
    expect(completed.pendingDeliveryAt).toBeUndefined();
    await pi.emit("session_shutdown", {}, ctx);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a read-only standby takes ownership after the active process releases its lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-schedule-failover-"));
  try {
    const project = join(root, "project"); const agentDir = join(root, "agent");
    const ownerPi = new MockPi(); const ownerCtx = context(project);
    scheduleExtension(ownerPi as any, { agentDir, leaseRetryMs: 10 });
    await ownerPi.emit("session_start", {}, ownerCtx);

    const standbyPi = new MockPi(); const standbyCtx = context(project);
    scheduleExtension(standbyPi as any, { agentDir, leaseRetryMs: 10 });
    await standbyPi.emit("session_start", {}, standbyCtx);
    expect(standbyCtx.statuses.has("schedule")).toBe(false);
    expect(standbyCtx.statusUpdates.some(({ text }) => text === "schedule read-only")).toBe(false);
    await standbyPi.commands.get("remind").handler("30m -- should be read only", standbyCtx);
    expect(standbyCtx.notifications.at(-1)).toContain("read-only");

    await ownerPi.emit("session_shutdown", {}, ownerCtx);
    await Bun.sleep(30);
    await standbyPi.commands.get("remind").handler("30m -- now writable", standbyCtx);
    expect(standbyCtx.notifications.at(-1)).toContain("scheduled for");
    await standbyPi.commands.get("schedule").handler("stop all", standbyCtx);
    await standbyPi.emit("session_shutdown", {}, standbyCtx);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const event of ["session_start", "session_tree", "session_shutdown"]) {
  for (const command of ["remind", "cron", "pause", "stop all", "schedule_stop"]) {
    for (const fail of [false, true]) {
      test(`${command}: delayed ${fail ? "failed" : "successful"} save cannot update UI after ${event}`, async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-schedule-navigation-"));
        const pi = new MockPi(); const ctx = context(join(root, "project"));
        const next = context(join(root, "next-project"));
        let defer = false;
        let entered = false;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        scheduleExtension(pi as any, { agentDir: join(root, "agent"), save: async (path, store) => {
          if (defer) { entered = true; await gate; if (fail) throw new Error("Delayed failure"); }
          await saveScheduleStore(path, store);
        } });
        try {
          await pi.emit("session_start", {}, ctx);
          await pi.commands.get("remind").handler("30m -- existing reminder", ctx);
          defer = true;
          const name = command === "pause" || command === "stop all" ? "schedule" : command;
          const args = command === "remind" ? "40m -- new reminder" : command === "cron" ? "0 9 * * * -- morning review" : command;
          const existing = await pi.tools.get("get_schedules").execute();
          const pending = command === "schedule_stop"
            ? pi.tools.get("schedule_stop").execute("stop", { task_id: existing.details.tasks[0].id }, undefined, undefined, ctx).then(
              () => { throw new Error("Stale tool execution reported success"); },
              (error: Error) => { expect(error.message).toContain(fail ? "Delayed failure" : "Session changed"); },
            )
            : pi.commands.get(name).handler(args, ctx);
          await waitFor(() => entered);
          const notifications = ctx.notifications.length;
          const statuses = ctx.statusUpdates.length;
          const navigation = pi.emit(event, {}, next);
          release();
          await Promise.all([pending, navigation]);
          expect(ctx.notifications).toHaveLength(notifications);
          expect(ctx.statusUpdates).toHaveLength(statuses);
          if (event !== "session_shutdown") {
            const state = await pi.tools.get("get_schedules").execute();
            expect(state.details.tasks).toEqual([]);
            expect(state.details.writable).toBe(true);
          }
        } finally {
          release();
          await pi.emit("session_shutdown", {}, next);
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}

for (const action of ["pause", "stop", "stop all"]) {
  for (const started of [false, true]) {
    test(`failed ${action} preserves ${started ? "running" : "queued"} delivery ownership`, async () => {
      const root = mkdtempSync(join(tmpdir(), "pi-schedule-rollback-"));
      const project = join(root, "project"); const agentDir = join(root, "agent");
      const path = scheduleStorePath(agentDir, project);
      const store = emptyScheduleStore(project);
      store.tasks.push(createReminder({ prompt: "check this delivery exactly once", runAt: Date.now() - 1000 }, Date.now() - 60000, "due"));
      await saveScheduleStore(path, store);
      const pi = new MockPi(); const ctx = context(project);
      let fail = false;
      scheduleExtension(pi as any, { agentDir, save: async (path, store) => {
        if (fail) throw new Error("Cannot save control change");
        await saveScheduleStore(path, store);
      } });
      try {
        await pi.emit("session_start", {}, ctx);
        await waitFor(() => pi.sent.length === 1);
        if (started) await pi.emit("agent_start", {}, ctx);
        fail = true;
        await pi.commands.get("schedule").handler(action, ctx);
        expect(ctx.notifications.at(-1)).toContain("Cannot save control change");
        fail = false;
        if (!started) await pi.emit("agent_start", {}, ctx);
        const [transformed] = await pi.emit("context", { messages: [{ role: "custom", ...pi.sent[0].message }] }, ctx);
        expect(transformed.messages[0]?.content).toContain("check this delivery exactly once");
        await pi.emit("agent_settled", {}, ctx);
        expect(loadScheduleStore(path, project).tasks[0]).toMatchObject({ status: "completed", runs: 1 });
        expect(pi.sent).toHaveLength(1);
      } finally {
        await pi.emit("session_shutdown", {}, ctx);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("settlement waits for a failed control save before completing its delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-schedule-settlement-"));
  const project = join(root, "project"); const agentDir = join(root, "agent");
  const path = scheduleStorePath(agentDir, project);
  const store = emptyScheduleStore(project);
  store.tasks.push(createReminder({ prompt: "settlement race", runAt: Date.now() - 1000 }, Date.now() - 60000, "due"));
  await saveScheduleStore(path, store);
  const pi = new MockPi(); const ctx = context(project);
  let failNext = false; let entered = false; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  scheduleExtension(pi as any, { agentDir, save: async (path, store) => {
    if (failNext) { failNext = false; entered = true; await gate; throw new Error("Control save failed"); }
    await saveScheduleStore(path, store);
  } });
  try {
    await pi.emit("session_start", {}, ctx);
    await waitFor(() => pi.sent.length === 1);
    await pi.emit("agent_start", {}, ctx);
    failNext = true;
    const control = pi.commands.get("schedule").handler("stop all", ctx);
    await waitFor(() => entered);
    const settled = pi.emit("agent_settled", {}, ctx);
    release();
    await Promise.all([control, settled]);
    expect(loadScheduleStore(path, project).tasks[0]).toMatchObject({ status: "completed", runs: 1 });
    expect(pi.sent).toHaveLength(1);
  } finally {
    release(); await pi.emit("session_shutdown", {}, ctx);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const first of ["stop all", "remind", "cron"] as const) {
  test(`a failed ${first} cannot erase or contaminate a concurrently created reminder`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-schedule-concurrent-"));
    const agentDir = join(root, "agent");
    const pi = new MockPi(); const ctx = context(join(root, "project"));
    let failNext = false;
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    scheduleExtension(pi as any, { agentDir, save: async (path, store) => {
      if (failNext) { failNext = false; entered = true; await gate; throw new Error("First write failed"); }
      await saveScheduleStore(path, store);
    } });
    try {
      await pi.emit("session_start", {}, ctx);
      await pi.commands.get("remind").handler("30m -- original", ctx);
      failNext = true;
      const failed = first === "stop all"
        ? pi.commands.get("schedule").handler(first, ctx)
        : pi.commands.get(first).handler(first === "remind" ? "30m -- should not exist" : "0 9 * * * -- should not exist", ctx);
      await waitFor(() => entered);
      const created = pi.commands.get("remind").handler("40m -- concurrent reminder", ctx);
      release();
      await Promise.all([failed, created]);
      const result = await pi.tools.get("get_schedules").execute();
      const disk = loadScheduleStore(scheduleStorePath(agentDir, ctx.cwd), ctx.cwd);
      expect(result.details.tasks).toEqual(disk.tasks);
      expect(disk.tasks.map((task) => task.prompt).sort()).toEqual(["concurrent reminder", "original"]);
      expect(disk.tasks.every((task) => task.status === "active")).toBe(true);
      expect(ctx.notifications.some((message) => message.includes("First write failed"))).toBe(true);
      expect(pi.sent).toHaveLength(0);
    } finally {
      release();
      await pi.emit("session_shutdown", {}, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
