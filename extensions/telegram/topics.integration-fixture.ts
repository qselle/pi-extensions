import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
import telegramExtension, { type TelegramRuntime } from "./index.ts";
import { TOPIC_ENTRY } from "./topics.ts";

const root = await mkdtemp(join(tmpdir(), "pi-topic-runtime-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
try {
  const calls: { method: string; body: any }[] = [];
  let topic = 100;
  let message = 1;
  let runtime: TelegramRuntime | undefined;
  const manager = SessionManager.create(root, join(root, "sessions"));
  const services = await createAgentSessionServices({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: SettingsManager.inMemory({}),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [(pi) => { runtime = telegramExtension(pi, {
        env: { PI_TELEGRAM_BOT_TOKEN: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi", PI_TELEGRAM_CHAT_ID: "12345" },
        configFile: false,
        fetch: async (url, init) => {
          const method = String(url).split("/").at(-1)!;
          const body = JSON.parse(String(init?.body)); calls.push({ method, body });
          assert.ok(["getMe", "createForumTopic", "editForumTopic", "sendMessage"].includes(method));
          const result = method === "getMe" ? { has_topics_enabled: true }
            : method === "createForumTopic" ? { message_thread_id: topic++ }
            : method === "sendMessage" ? { message_id: message++ } : true;
          return Response.json({ ok: true, result });
        },
      }); }],
    },
  });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: getModels("anthropic")[0]! });
  const runner = session.extensionRunner;
  const errors: string[] = [];
  runner.onError((error) => errors.push(error.error));
  runner.setUIContext({ ...runner.getUIContext(), notify: () => {} }, "tui");
  try {
    await runner.emit({ type: "session_start", reason: "startup" });
    assert.equal(calls.length, 0);
    session.setSessionName("API Review");
    await session.prompt("/telegram test");
    assert.equal(calls.find((call) => call.method === "createForumTopic")?.body.name, "API Review");
    assert.equal(calls.at(-1)?.body.message_thread_id, 100);
    session.setSessionName("API Rollout");
    await runtime!.service.send("Follow-up");
    assert.ok(calls.some((call) => call.method === "editForumTopic" && call.body.name === "API Rollout"));
    await runner.emit({ type: "session_start", reason: "reload" });
    await session.prompt("/telegram test");
    assert.equal(calls.filter((call) => call.method === "createForumTopic").length, 1);
    const old = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === TOPIC_ENTRY);
    manager.newSession();
    for (const entry of old) if (entry.type === "custom") manager.appendCustomEntry(entry.customType, entry.data);
    await runner.emit({ type: "session_start", reason: "fork" });
    await session.prompt("/telegram test");
    assert.equal(calls.at(-1)?.body.message_thread_id, 101);
    await session.prompt("/telegram topic name Stable Label");
    assert.equal(calls.at(-1)?.body.name, "Stable Label");
    await session.prompt("/telegram topic new");
    await session.prompt("/telegram test");
    assert.equal(calls.at(-1)?.body.message_thread_id, 102);
    assert.deepEqual(errors, []);
  } finally {
    await runner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
  }
  console.log("native Pi session topics, renaming, fork isolation and recovery commands verified");
} finally { await rm(root, { recursive: true, force: true }); }
