import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReloadAllExtension, type ReloadRuntime } from "./index.ts";
import { Registry, describeStatus, identityFor } from "./store.ts";

const root = await mkdtemp(join(tmpdir(), "pi-reload-native-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_RELOAD_ALL_DIR = join(root, "registry");
delete process.env.PI_SUBAGENT_CHILD;
let network = 0;
globalThis.fetch = (() => { network++; throw new Error("Native reload fixture must not use network"); }) as unknown as typeof fetch;
const sessions: Array<Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"]> = [];
const errors: string[] = [];
const store = new Registry(process.env.PI_RELOAD_ALL_DIR);
let nextId = 4000;

async function create(collision = false, mode: "tui" | "rpc" = "tui") {
  const directory = join(root, String(++nextId)); await mkdir(directory);
  const identity = identityFor(nextId, randomUUID());
  let controller!: ReloadRuntime; let reloads = 0; let modelTurns = 0; let releaseDialog: (() => void) | undefined;
  const notices: string[] = [];
  const install = (pi: ExtensionAPI) => {
    createReloadAllExtension({ identity, intervalMs: 1_000_000, onRuntime: value => { controller = value; } })(pi);
    pi.registerCommand("fixture-dialog", { description: "Isolated fixture", handler: async (_args, ctx) => { await ctx.ui.confirm("Fixture", "Hold reload"); } });
    pi.on("before_agent_start", () => { modelTurns++; throw new Error("Coordination input reached a model turn"); });
  };
  const duplicate = (pi: ExtensionAPI) => pi.registerCommand("reload-all", { description: "Collision fixture", handler: async () => {} });
  const services = await createAgentSessionServices({ cwd: directory, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({}),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      extensionFactories: collision ? [install, duplicate] : [install] } });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(directory), noTools: "all" });
  sessions.push(session);
  await session.bindExtensions({ mode, onError: error => errors.push(error.error),
    uiContext: { ...session.extensionRunner.getUIContext(), notify: message => notices.push(message),
      confirm: async () => { await new Promise<void>(resolve => { releaseDialog = resolve; }); return true; } },
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(), newSession: async () => ({ cancelled: true }), fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }), switchSession: async () => ({ cancelled: true }),
      reload: async () => { reloads++; await session.reload(); },
    },
  });
  return { session, identity, notices, tick: () => controller.tick(), reloads: () => reloads, modelTurns: () => modelTurns,
    hasDialog: () => !!releaseDialog, closeDialog: () => { releaseDialog?.(); releaseDialog = undefined; } };
}
async function waitFor(predicate: () => Promise<boolean> | boolean) {
  const end = Date.now() + 3_000;
  while (!await predicate()) { if (Date.now() > end) throw new Error("Native reload handshake timed out"); await Bun.sleep(5); }
}

try {
  const first = await create(); const second = await create(); const rpc = await create(false, "rpc");
  assert.equal((await store.targets()).length, 2);
  assert(first.session.extensionRunner.getCommand("reload-all"), "command is available before a broadcast");
  const oldRunner = second.session.extensionRunner;
  const oldNonce = (await store.target(second.identity.key))!.runtimeNonce;
  const dialog = second.session.prompt("/fixture-dialog");
  await waitFor(second.hasDialog);
  await first.session.prompt("/reload-all");
  await second.tick();
  assert.equal(first.reloads(), 1); assert.equal(second.reloads(), 0, "native UI prompt events defer the receiving runtime");
  assert((await describeStatus(store, Date.now())).includes("1 waiting"));
  second.closeDialog(); await dialog; await second.tick();
  await waitFor(async () => (await store.target(second.identity.key))?.state === "applied");
  assert.equal(second.reloads(), 1);
  assert.notEqual(second.session.extensionRunner, oldRunner, "Pi created a new extension runner");
  assert.notEqual((await store.target(second.identity.key))!.runtimeNonce, oldNonce);
  assert.equal(await describeStatus(store, Date.now()), "2 sessions · 2 applied");
  await first.session.prompt("/reload-all status");
  assert(first.notices.at(-1)?.includes("2 applied"), "status command remains loaded after native reload");
  const late = await create(); await late.tick(); assert.equal(late.reloads(), 0);
  await rpc.tick(); assert.equal(rpc.reloads(), 0);
  for (let i = 0; i < 3; i++) { await first.tick(); await second.tick(); }
  assert.equal(second.reloads(), 1);
  const collided = await create(true);
  assert.equal(collided.session.extensionRunner.getCommand("reload-all"), undefined);
  assert(collided.session.extensionRunner.getCommand("reload-all:1"), "native Pi renames the duplicate command");
  await collided.session.prompt(`/reload-all __apply ${randomUUID()} ${randomUUID()}`);
  assert.equal(collided.modelTurns(), 0, "private coordination fallthrough is consumed by the native input hook");
  assert.equal(collided.session.messages.length, 0, "internal forms do not enter the transcript");
  assert.equal(first.modelTurns() + second.modelTurns() + late.modelTurns() + rpc.modelTurns(), 0);
  assert.equal(network, 0);
  assert.deepEqual(errors, []);
  console.log("native two-runtime reload handshake, dialogs, command loading and collision sink verified");
} finally {
  for (const session of sessions) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  await rm(root, { recursive: true, force: true });
}
