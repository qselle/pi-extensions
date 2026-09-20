import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
const root = await mkdtemp(join(tmpdir(), "pi-package-runtime-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
// Avoid machine-local service configuration in this isolated package smoke test.
for (const key of Object.keys(process.env)) if (/^(TELEGRAM_|PI_TELEGRAM_)/.test(key)) delete process.env[key];
let requests = 0;
globalThis.fetch = (() => { requests++; throw new Error("Package smoke test forbids network"); }) as unknown as typeof fetch;
const packageRoot = process.env.PI_TEST_PACKAGE_ROOT ?? import.meta.dir;
const paths = (await readdir(join(packageRoot, "extensions"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => join(packageRoot, "extensions", entry.name, "index.ts")).sort();
if (process.argv.includes("--reverse")) paths.reverse();
let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
try {
  const services = await createAgentSessionServices({ cwd: root, agentDir,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    resourceLoaderOptions: { additionalExtensionPaths: paths, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true } });
  const loaded = services.resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, paths.length);
  assert.equal(loaded.extensions.filter((extension) => extension.tools.has("bash")).length, 1);
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(root, join(root, "sessions")), model: getModels("anthropic")[0]! }));
  const errors: unknown[] = [];
  session.extensionRunner.onError((error) => errors.push(error));
  await session.bindExtensions({});
  const active = session.getActiveToolNames();
  assert.equal(active.length, 14, `Fresh default tool surface: ${active.join(", ")}`);
  for (const name of ["job_start", "job_wait", "get_goal", "loop_schedule", "get_monitors", "get_schedules"]) assert(!active.includes(name), `${name} should be deferred`);
  for (const name of ["bash", "create_goal", "update_plan", "questionnaire", "subagents", "web_search", "web_read"]) assert(active.includes(name), `${name} must remain discoverable`);
  const commands = session.extensionRunner.getRegisteredCommands().map((command) => command.name);
  for (const name of ["fast", "web", "doctor", "schedule", "rewind", "transcript", "jobs", "handoff", "image-history", "turn-stats"]) assert(commands.includes(name), name);
  const tools = session.extensionRunner.getAllRegisteredTools().map((tool) => tool.definition.name);
  for (const name of ["web_search", "web_read", "job_start", "history_image", "context_notes"]) assert(tools.includes(name), name);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(errors, []);
  assert.equal(requests, 0);
  console.log(`All ${paths.length} extensions loaded and shut down without network`);
} finally {
  session?.dispose();
  await rm(root, { recursive: true, force: true });
}
