import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, initTheme } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "./index.ts";
import { ENTRY } from "./service.ts";
import { fakeHerdr } from "./socket-fixture.ts";

const wire = await fakeHerdr();
const agentDir = join(wire.root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
globalThis.fetch = (() => { throw new Error("Network forbidden in terminal fixture"); }) as unknown as typeof fetch;
const model = getModels("anthropic")[0]!;
const errors: string[] = [];
let installations = 0;
const sessions: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"][] = [];
const create = async (manager: SessionManager, mode: "tui" | "rpc" = "tui", env: NodeJS.ProcessEnv = wire.env) => {
  const services = await createAgentSessionServices({ cwd: wire.root, agentDir, settingsManager: SettingsManager.inMemory({}),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
      extensionFactories: [(pi) => { installations++; extension(pi, { env }); }] } });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model });
  sessions.push(session);
  await session.bindExtensions({ mode, uiContext: { ...session.extensionRunner.getUIContext(), notify() {} }, onError: (error) => errors.push(error.error) });
  return session;
};
try {
  initTheme("dark", false);
  const manager = SessionManager.create(wire.root, join(wire.root, "sessions"));
  manager.appendMessage({ role: "user", content: "Synthetic request", timestamp: 1 });
  manager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 2,
    content: [{ type: "text", text: "Synthetic reply makes ownership durable" }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const session = await create(manager);
  const run = (args: any) => {
    const runner = session.extensionRunner;
    return runner.getToolDefinition("terminal_process")!.execute("synthetic", args, undefined, undefined, runner.createContext());
  };
  assert(session.getActiveToolNames().includes("terminal_process"));
  const started = await run({ action: "start", command: "  printf 'literal $HOME'\n", label: "Native fixture" });
  assert.equal((started.details as { paneId: string }).paneId, "w1:p2");
  assert.equal(wire.requests.filter((r) => r.method === "pane.send_input").length, 1);
  const saved = JSON.parse((await readFile(manager.getSessionFile()!, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(saved.customType, ENTRY);
  assert.equal(saved.data.stage, "submitted");
  assert.equal(saved.data.sessionId, manager.getSessionId());
  assert(!JSON.stringify(saved).includes(wire.path), "ownership never stores the raw socket path");
  const theme = { fg: (_color: string, text: string) => text } as any;
  const tool = session.extensionRunner.getToolDefinition("terminal_process")!;
  for (const width of [1, 20, 80]) {
    for (const component of [tool.renderCall!({ action: "input", text: "DO-NOT-ECHO" }, theme, {} as any),
      tool.renderResult!(started, { expanded: false, isPartial: false }, theme, {} as any)]) {
      assert(component);
      const lines = component.render(width);
      assert(lines.every((line) => visibleWidth(line) <= width));
      assert(!lines.join("\n").includes("DO-NOT-ECHO"));
    }
  }
  for (let i = 0; i < 3; i++) {
    await session.reload();
    assert.equal(session.getAllTools().filter((tool) => tool.name === "terminal_process").length, 1);
    assert((await run({ action: "list" })).content[0].type === "text");
    await run({ action: "status", pane_id: "w1:p2" });
  }
  assert.equal(installations, 4);
  const oldLeafId = manager.getLeafId(); manager.resetLeaf();
  await session.extensionRunner.emit({ type: "session_tree", oldLeafId, newLeafId: null });
  assert(JSON.stringify(await run({ action: "list" })).includes("w1:p2"), "tree navigation retains session-owned panes");
  const resumedManager = SessionManager.open(manager.getSessionFile()!);
  const resumed = await create(resumedManager);
  const resumedRunner = resumed.extensionRunner;
  await resumedRunner.getToolDefinition("terminal_process")!.execute("resumed", { action: "input", pane_id: "w1:p2", press_enter: true }, undefined, undefined, resumedRunner.createContext());
  assert.deepEqual(wire.requests.at(-1)!.params, { pane_id: "w1:p2", text: "", keys: ["Enter"] });
  const fork = SessionManager.forkFrom(manager.getSessionFile()!, wire.root, join(wire.root, "fork"));
  const forkSession = await create(fork), forkRunner = forkSession.extensionRunner;
  assert.notEqual(fork.getSessionId(), manager.getSessionId());
  assert(fork.getEntries().some((entry) => entry.type === "custom" && entry.customType === ENTRY));
  await assert.rejects(forkRunner.getToolDefinition("terminal_process")!.execute("fork", { action: "interrupt", pane_id: "w1:p2" }, undefined, undefined, forkRunner.createContext()), /this Pi session/);
  for (const [mode, env] of [["rpc", wire.env], ["tui", { ...wire.env, HERDR_ENV: "0" }], ["tui", { ...wire.env, PI_SUBAGENT_CHILD: "1" }]] as const) {
    const inactive = await create(SessionManager.inMemory(wire.root), mode, env);
    assert.equal(inactive.extensionRunner.getToolDefinition("terminal_process"), undefined);
  }
  const beforeShutdown = wire.requests.length;
  for (const current of sessions) await current.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(wire.requests.length, beforeShutdown);
  assert.equal(wire.panes.size, 2, "shutdown leaves the mock Herdr-owned process pane intact");
  assert.deepEqual(errors, []);
  console.log("native Pi persistence, reload, resume, fork isolation, rendering and Herdr wire protocol verified");
} finally {
  for (const session of sessions) session.dispose();
  await wire.close();
}
