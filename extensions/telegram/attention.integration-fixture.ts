import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
import goalExtension from "../goal/index.ts";
import { GOAL_ATTENTION_EVENT } from "../goal/events.ts";
import scheduleExtension from "../schedule/index.ts";
import { SCHEDULE_ATTENTION_EVENT } from "../schedule/events.ts";
import { createReminder } from "../schedule/schedule.ts";
import { emptyScheduleStore, saveScheduleStore, scheduleStorePath } from "../schedule/store.ts";
import telegramExtension, { type TelegramRuntime } from "./index.ts";

const root = await mkdtemp(join(tmpdir(), "pi-attention-runtime-"));
const model = getModels("anthropic")[0]!;
let serial = 0;

async function runtime(source: "goal" | "schedule", reverse: boolean, failure?: string) {
  const cwd = join(root, String(serial++)); const agentDir = join(cwd, "agent");
  await mkdir(cwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (source === "schedule") {
    const path = scheduleStorePath(agentDir, cwd);
    if (failure === "queue_read") {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "private corrupted queue");
    } else {
      const store = emptyScheduleStore(cwd);
      store.tasks.push(createReminder({ prompt: "private scheduled prompt", runAt: Date.now() - 1_000 }, Date.now() - 60_000, "scheduled"));
      await saveScheduleStore(path, store);
    }
  }
  const messages: string[] = []; const alerts: any[] = []; const tools = new Map<string, any>();
  let ctx!: ExtensionContext; let telegram!: TelegramRuntime; let wakes = 0; let saves = 0;
  const observe = (pi: ExtensionAPI) => {
    pi.on("session_start", (_event, context) => { ctx = context; });
    const stop = pi.events.on(source === "goal" ? GOAL_ATTENTION_EVENT : SCHEDULE_ATTENTION_EVENT, (event) => { alerts.push(event); });
    pi.on("session_shutdown", () => stop());
  };
  const installSource = (pi: ExtensionAPI) => {
    // Keep Pi's real extension runner and event bus, but prevent a wake from
    // starting any provider request and allow explicit failure injection.
    const adapted = new Proxy(pi, { get(target, key, receiver) {
      if (key === "sendMessage") return () => { if (failure === "wakeup") throw new Error("private wake error"); wakes++; };
      if (key === "registerTool") return (tool: any) => { tools.set(tool.name, tool); target.registerTool(tool); };
      return Reflect.get(target, key, receiver);
    } });
    if (source === "goal") goalExtension(adapted);
    else scheduleExtension(adapted, { agentDir, save: async (path, store) => {
      saves++;
      if (failure === "queue_write" || failure === "completion_write" && saves === 2) throw new Error("private persistence error");
      await saveScheduleStore(path, store);
    } });
  };
  const installTelegram = (pi: ExtensionAPI) => { telegram = telegramExtension(pi, { service: {
    send: async (text) => { messages.push(text); return { messageId: messages.length }; },
    openPrompt: async () => { throw new Error("unused"); }, drain: async () => {}, shutdown: async () => {},
  } })!; };
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: SettingsManager.inMemory({}),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      extensionFactories: [observe, ...(reverse ? [installTelegram, installSource] : [installSource, installTelegram])] } });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model });
  let runner = session.extensionRunner;
  const errors: string[] = [];
  await session.bindExtensions({ uiContext: { ...runner.getUIContext(), notify: () => {} }, mode: "rpc", onError: (error) => errors.push(error.error) });
  return { get runner() { return runner; }, messages, alerts, manager, tools, context: () => ctx, wakes: () => wakes, drain: () => telegram.notifier.drain(),
    reload: async () => { await session.reload(); runner = session.extensionRunner; },
    close: async () => { await runner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); assert.deepEqual(errors, []); } };
}

function assistant(stopReason: "stop" | "error" | "aborted", tokens = 10, errorMessage?: string): any {
  return { role: "assistant", api: "test", model: "test", provider: "test", content: [], stopReason, errorMessage, timestamp: Date.now(),
    usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Attention fixture timed out"); await Bun.sleep(5); }
}

try {
  for (const reverse of [false, true]) {
    for (const status of ["blocked", "stalled", "budget_limited", "usage_limited", "paused", "complete"]) {
      const r = await runtime("goal", reverse);
      try {
        await r.tools.get("create_goal").execute("create", { objective: "private goal objective", ...(["budget_limited", "usage_limited"].includes(status) ? { token_budget: 1 } : {}) }, undefined, undefined, r.context());
        if (status === "blocked") {
          for (let i = 0; i < 3; i++) {
            await r.runner.emit({ type: "agent_start" });
            await r.tools.get("update_goal").execute(`block-${i}`, { status: "blocked", blocker: "private blocker", evidence: "private evidence", next_input: "private next input" }, undefined, undefined, r.context());
            await r.runner.emit({ type: "agent_settled" });
          }
        } else {
          await r.runner.emit({ type: "agent_start" });
          if (status === "complete") await r.tools.get("update_goal").execute("complete", { status: "complete" }, undefined, undefined, r.context());
          else await r.runner.emitMessageEnd({ type: "message_end", message: assistant(status === "paused" ? "aborted" : status === "budget_limited" ? "stop" : "error", 10, status === "usage_limited" ? "private usage limit reached" : "private provider error") });
          await r.runner.emit({ type: "agent_settled" });
        }
        await r.drain();
        const attention = !["paused", "complete"].includes(status);
        assert.equal(r.alerts.length, attention ? 1 : 0, `${status}: exactly one terminal warning`);
        if (attention) {
          assert.equal(r.alerts[0].status, status);
          assert.equal(r.alerts[0].sessionId, r.manager.getSessionId());
          assert.equal(r.messages.length, 1);
          assert.ok(!JSON.stringify(r.alerts).includes("private"));
          assert.ok(!r.messages.join(" ").includes("private"));
        } else assert.equal(r.messages.length, status === "complete" ? 1 : 0, "existing completion notification remains intact");
        const delivered = r.messages.length;
        await r.reload();
        await r.drain();
        assert.equal(r.messages.length, delivered, "native reload restores warning states quietly");
      } finally { await r.close(); }
    }

    for (const failure of ["queue_read", "queue_write", "wakeup", "agent", "completion_write", "aborted", "none"]) {
      const r = await runtime("schedule", reverse, failure);
      try {
        if (["queue_read", "queue_write", "wakeup"].includes(failure)) await waitFor(() => r.alerts.length === 1);
        else {
          await waitFor(() => r.wakes() === 1);
          await r.runner.emit({ type: "agent_start" });
          if (failure === "agent" || failure === "aborted") await r.runner.emitMessageEnd({ type: "message_end", message: assistant(failure === "agent" ? "error" : "aborted", 0, "private scheduled error") });
          if (failure === "agent") await r.runner.emitMessageEnd({ type: "message_end", message: assistant("error", 0, "private repeated error") });
          await r.runner.emit({ type: "agent_settled" });
        }
        await r.drain();
        const count = ["aborted", "none"].includes(failure) ? 0 : 1;
        assert.equal(r.alerts.length, count, `${failure}: warning count`);
        assert.equal(r.messages.length, count, `${failure}: Telegram delivery count in either load order`);
        assert.ok(!JSON.stringify(r.alerts).includes("private"));
        assert.ok(!r.messages.join(" ").includes("private"));
        if (count) assert.equal(r.alerts[0].sessionId, r.manager.getSessionId());
      } finally { await r.close(); }
    }
  }
  console.log("native goal and schedule attention delivery, quiet cancellation and session isolation verified in both load orders");
} finally { await rm(root, { recursive: true, force: true }); }
