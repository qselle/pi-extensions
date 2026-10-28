import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";
import { deferredTools } from "./deferred-tools.ts";

const root = await mkdtemp(join(tmpdir(), "pi-deferred-tools-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.ANTHROPIC_API_KEY = "fixture-not-a-real-key";
globalThis.fetch = (() => { throw new Error("Network forbidden"); }) as unknown as typeof fetch;
const model = getModels("anthropic")[0]!;
let api!: ExtensionAPI;
let controls!: ReturnType<typeof deferredTools>;
const extension = (pi: ExtensionAPI) => {
  api = pi;
  controls = deferredTools(pi, ["fixture_stop", "fixture_list"], { registeredInactive: true });
  for (const name of ["fixture_stop", "fixture_list"]) {
    pi.registerTool({ name, defaultActive: false, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) });
  }
  pi.on("session_start", () => controls.initialize());
};
const open = async (manager: SessionManager) => {
  const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, extensionFactories: [extension] } });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model });
  await session.bindExtensions({});
  return session;
};
try {
  const manager = SessionManager.create(root, join(root, "sessions"));
  const session = await open(manager);
  const before = api.getActiveTools();
  assert(!before.includes("fixture_stop"), "controls stay inactive until first use");
  controls.activate(["fixture_stop"]);
  assert.deepEqual(api.getActiveTools(), [...before, "fixture_stop"], "activation only appends");
  session.agent.streamFunction = async () => {
    const message = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop" as const,
      content: [{ type: "text" as const, text: "done" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
    return stream;
  };
  await session.prompt("record the active tools");
  const recorded = api.getActiveTools();
  session.dispose();

  await open(SessionManager.open(manager.getSessionFile()!));
  assert.deepEqual(api.getActiveTools(), recorded, "a resumed branch keeps its activated controls and loses none");
  controls.activate();
  assert.deepEqual(api.getActiveTools(), [...recorded, "fixture_list"], "remaining controls append after resume");
  console.log("deferred controls activate additively and survive resume");
} finally {
  await rm(root, { recursive: true, force: true });
}
