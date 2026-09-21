import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
import titleExtension from "./index.ts";

const root = await mkdtemp(join(tmpdir(), "pi-tab-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const path = join(root, "api.sock");
const tab = { tab_id: "w1:t1", label: "1", pane_count: 1 };
const pane = { pane_id: "w1:p3", tab_id: tab.tab_id, terminal_id: "term3" };
const writes: string[] = [];
const sockets = new Set<Socket>();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (!buffer.includes("\n")) return;
    const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
    assert.ok(["pane.get", "tab.get", "tab.rename"].includes(request.method));
    if (request.method === "tab.rename") {
      assert.equal(request.params.tab_id, tab.tab_id);
      tab.label = request.params.label;
      writes.push(tab.label);
    }
    const result = request.method === "pane.get" ? { type: "pane_info", pane } : { type: "tab_info", tab };
    socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
  });
});
try {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const manager = SessionManager.create(root, join(root, "sessions"));
  const services = await createAgentSessionServices({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: SettingsManager.inMemory({}),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [(pi) => titleExtension(pi, {
        config: { enabled: false },
        tabLink: { env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: path, HERDR_PANE_ID: pane.pane_id } },
        request: async () => { throw new Error("Tab linking must not request a model"); },
      })],
    },
  });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: getModels("anthropic")[0]! });
  const runner = session.extensionRunner;
  const errors: string[] = [];
  runner.onError((error) => errors.push(error.error));
  runner.setUIContext({ ...runner.getUIContext(), notify: () => {} }, "tui");
  const idle = () => session.prompt("/title tab status");
  try {
    await runner.emit({ type: "session_start", reason: "startup" });
    session.setSessionName("External Name");
    await idle();
    assert.equal(tab.label, "External Name");
    await session.prompt("/rename API: v2 rollout");
    await idle();
    assert.equal(tab.label, "API: v2 rollout");
    await runner.emit({ type: "session_start", reason: "reload" });
    await session.prompt("/title set Reloaded Name");
    await idle();
    assert.equal(tab.label, "Reloaded Name");
    tab.label = "Human Label";
    session.setSessionName("Keep This In Pi");
    await idle();
    assert.equal(tab.label, "Human Label");
    await session.prompt("/title tab link");
    assert.equal(tab.label, "Keep This In Pi");
    assert.deepEqual(writes, ["External Name", "API: v2 rollout", "Reloaded Name", "Keep This In Pi"]);
    assert.ok(manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "session-title:tab-link"));
    assert.deepEqual(errors, []);
  } finally {
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  console.log("native Pi title events, commands, persistence and Herdr socket exchange verified");
} finally {
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
