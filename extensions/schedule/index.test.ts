import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import scheduleExtension from "./index.ts";
import { createReminder } from "./schedule.ts";
import { emptyScheduleStore, loadScheduleStore, saveScheduleStore, scheduleStorePath } from "./store.ts";

type Handler = (event: any, ctx: any) => any;
class MockPi {
  handlers = new Map<string, Handler[]>(); commands = new Map<string, any>(); tools = new Map<string, any>(); sent: any[] = [];
  on(event: string, handler: Handler) { const list = this.handlers.get(event) ?? []; list.push(handler); this.handlers.set(event, list); }
  registerCommand(name: string, command: any) { this.commands.set(name, command); }
  registerTool(tool: any) { this.tools.set(tool.name, tool); }
  sendMessage(message: unknown, options: unknown) { this.sent.push({ message, options }); }
  async emit(event: string, payload: unknown, ctx: any) { const out = []; for (const handler of this.handlers.get(event) ?? []) out.push(await handler(payload, ctx)); return out; }
}
function context(project: string) {
  const notifications: string[] = [];
  return { cwd: project, mode: "tui", isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify: (message: string) => notifications.push(message), setStatus: () => undefined }, notifications };
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
    await pi.emit("session_start", {}, ctx); await Bun.sleep(25);
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
