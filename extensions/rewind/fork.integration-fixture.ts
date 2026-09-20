import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  SessionManager, type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

const root = await mkdtemp(join(tmpdir(), "pi-rewind-fork-"));
const factory: CreateAgentSessionRuntimeFactory = async (options) => {
  const services = await createAgentSessionServices({
    cwd: options.cwd, agentDir: options.agentDir,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
  });
  const result = await createAgentSessionFromServices({ services, sessionManager: options.sessionManager, noTools: "all" });
  return { ...result, services, diagnostics: [] };
};
let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
try {
  const parent = SessionManager.create(root, join(root, "sessions"));
  parent.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
  parent.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }],
    api: "openai-completions", provider: "test", model: "test", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const selected = parent.appendMessage({ role: "user", content: "second\nprompt", timestamp: Date.now() });
  runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir: join(root, "agent"), sessionManager: parent });
  const originalPath = parent.getSessionFile()!;
  const original = await readFile(originalPath, "utf8");
  let freshId: string | undefined;
  const result = await runtime.fork(selected, { position: "before", withSession: async (ctx) => { freshId = ctx.sessionManager.getSessionId(); } });
  assert.equal(result.cancelled, false);
  assert.equal(result.selectedText, "second\nprompt");
  assert.notEqual(freshId, parent.getSessionId());
  const forkText = JSON.stringify(runtime.session.sessionManager.buildSessionContext().messages);
  assert(forkText.includes("first prompt"));
  assert(forkText.includes("first answer"));
  assert(!forkText.includes("second"));
  assert.equal(await readFile(originalPath, "utf8"), original);
  console.log("real fork preserves original and excludes selected prompt");
} finally {
  runtime?.session.dispose();
  await rm(root, { recursive: true, force: true });
}
