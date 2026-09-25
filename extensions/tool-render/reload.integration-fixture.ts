import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai/compat";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { BASH_OWNER, BASH_STYLE } from "../background-jobs/bash-style.ts";

const root = await mkdtemp(join(tmpdir(), "pi-bash-reload-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_OFFLINE = "1";
globalThis.fetch = (() => { throw new Error("Network forbidden in reload fixture"); }) as unknown as typeof fetch;
const { default: renderer } = await import("./index.ts");
const { default: background } = await import("../background-jobs/index.ts");
let withBackground = true;
let counts = { owners: 0, styles: 0 };
const errors: string[] = [];
const runtime = await createAgentSessionRuntime(async ({ sessionManager }) => {
  const services = await createAgentSessionServices({ cwd: root, agentDir: root,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, extensionFactories: [
      (pi) => { if (withBackground) background(pi); }, renderer,
      (pi) => pi.registerCommand("probe-bash-owners", { description: "Fixture probe", handler: async () => {
        counts = { owners: 0, styles: 0 };
        pi.events.emit(BASH_OWNER, { claim: () => counts.owners++ });
        pi.events.emit(BASH_STYLE, { provide: () => counts.styles++ });
      } }),
    ] } });
  const result = await createAgentSessionFromServices({ services, sessionManager, model: getModels("anthropic")[0]! });
  result.session.extensionRunner.onError((error) => errors.push(error.error));
  return { ...result, services, diagnostics: [] };
}, { cwd: root, agentDir: root, sessionManager: SessionManager.create(root, join(root, "sessions")) });
const probe = async (owners: number, styles: number) => {
  const runner = runtime.session.extensionRunner;
  await runner.getCommand("probe-bash-owners")!.handler("", runner.createCommandContext());
  assert.deepEqual(counts, { owners, styles });
};
try {
  await runtime.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
  await probe(1, 1);
  for (let i = 0; i < 3; i++) { await runtime.session.reload(); await probe(1, 1); }
  await writeFile(join(root, "tool-render.json"), JSON.stringify({ enabled: false }));
  await runtime.session.reload();
  await probe(1, 0);
  withBackground = false;
  await writeFile(join(root, "tool-render.json"), JSON.stringify({ enabled: true }));
  await runtime.session.reload();
  await probe(0, 1);
  assert.deepEqual(errors, []);
  console.log("native Bash reload ownership and style cleanup verified");
} finally {
  await runtime.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  runtime.session.dispose();
  await rm(root, { recursive: true, force: true });
}
