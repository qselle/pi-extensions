/** Isolated real-TUI fixture for visual inspection; never uses a live provider. */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, InteractiveMode, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createLoop, encodeLoopSnapshot, pauseLoop } from "../extensions/loop/loop.ts";

const root = process.env.PI_UI_PREVIEW_ROOT;
if (!root) throw new Error("Run this fixture through the UI preview controller.");
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const agentDir = join(root, "agent");
await mkdir(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
process.env.ANTHROPIC_API_KEY = "synthetic-preview-key";
for (const key of ["EXA_API_KEY", "FIRECRAWL_API_KEY", "MISTRAL_API_KEY"]) delete process.env[key];
for (const key of Object.keys(process.env)) if (/^(TELEGRAM_|PI_TELEGRAM_)/.test(key)) delete process.env[key];
await writeFile(join(agentDir, "notify.json"), '{"enabled":false}');
await writeFile(join(agentDir, "session-title.json"), '{"enabled":false}');
let networkAttempts = 0;
globalThis.fetch = (() => { networkAttempts++; throw new Error("UI preview forbids network"); }) as unknown as typeof fetch;
const paths = (await readdir(join(repo, "extensions"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => join(repo, "extensions", entry.name, "index.ts")).sort();
const model = getModels("anthropic").find((model) => model.id === "claude-sonnet-4-6") ?? getModels("anthropic")[0]!;
const manager = SessionManager.create(root, join(root, "sessions"));
manager.appendSessionInfo("Research toolkit");
manager.appendMessage({ role: "user", content: [{ type: "text", text: "Find the TypeScript references for this project." }], timestamp: Date.now() });
// Seed a recorded web result to exercise the real renderer without an HTTP request.
const usage = { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 140, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
manager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "toolUse", usage,
  content: [{ type: "toolCall", id: "preview-search", name: "web_search", arguments: { query: "TypeScript compiler documentation", limit: 3 } }] });
manager.appendMessage({ role: "toolResult", toolCallId: "preview-search", toolName: "web_search", timestamp: Date.now(), isError: false,
  content: [{ type: "text", text: "Three documentation sources returned." }],
  details: { query: "TypeScript compiler documentation", provider: "exa", access: "keyless", elapsedMs: 218, results: [
    { title: "TypeScript Handbook", url: "https://www.typescriptlang.org/docs/handbook/intro.html", snippet: "An introduction to TypeScript." },
    { title: "Compiler options", url: "https://www.typescriptlang.org/tsconfig/", snippet: "Reference for project configuration." },
    { title: "Node.js TypeScript support", url: "https://nodejs.org/api/typescript.html", snippet: "Running TypeScript with Node.js." },
  ] } });
await mkdir(join(root, "src"));
await writeFile(join(root, "src/research.ts"), 'export async function search(query: string) {\n  return [{ title: query, url: "https://example.com" }];\n}\n');
await writeFile(join(root, "src/types.ts"), 'export interface Source { title: string; url: string }\n');
manager.appendCustomEntry("loop-state", encodeLoopSnapshot([
  pauseLoop(createLoop("Review the research interface at narrow widths.\nKeep full prompts searchable and preserve the next useful action. ".repeat(8), 300_000, Date.now(), "preview-loop"), "Paused for inspection"),
]));
const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
  const services = await createAgentSessionServices({ cwd, agentDir,
    settingsManager: SettingsManager.inMemory({ quietStartup: true, lastChangelogVersion: "0.87.0", enableInstallTelemetry: false, enableAnalytics: false,
      compaction: { enabled: false }, theme: "gruvbox-dark", tuiMode: "fullscreen", hideThinkingBlock: true, markdown: { codeBlockIndent: "│ " } }),
    resourceLoaderOptions: { additionalExtensionPaths: paths, additionalThemePaths: [join(repo, "themes/gruvbox-dark.json")], noSkills: true, noPromptTemplates: true, noContextFiles: true } });
  const loaded = services.resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, paths.length);
  const result = await createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel: "high" });
  return { ...result, services, diagnostics: services.diagnostics };
}, { cwd: root, agentDir, sessionManager: manager });
const errors: string[] = [];
runtime.session.extensionRunner.onError((error) => errors.push(error.error));
process.on("exit", () => writeFileSync(join(root, "result.json"), JSON.stringify({ errors, networkAttempts, extensions: paths.length })));
const mode = new InteractiveMode(runtime, { tuiMode: "fullscreen" });
await mode.init();
await writeFile(join(root, "phase"), "gallery");
while (await readFile(join(root, "gallery-continue"), "utf8").catch(() => "") !== "yes") await delay(25);
await runtime.session.prompt("/prevent-sleep off");
await runtime.session.prompt("/working-style pulse");
let call = 0;
runtime.session.agent.streamFunction = async (_model, _context, options) => {
  await options?.onPayload?.({ fixture: true }, model);
  const tool = call++ === 0;
  if (!tool) {
    await writeFile(join(root, "phase"), "tools");
    while (await readFile(join(root, "tools-continue"), "utf8").catch(() => "") !== "yes") await delay(25);
  }
  const message: AssistantMessage = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    stopReason: tool ? "toolUse" as const : "stop" as const,
    content: tool ? [{ type: "toolCall" as const, id: "preview-plan", name: "update_plan", arguments: { plan: [
      { step: "Review the interface", status: "completed" },
      { step: "Improve research tools", status: "in_progress" },
      { step: "Verify behavior and document usage", status: "pending" },
    ] } },
    { type: "toolCall" as const, id: "preview-read-a", name: "read", arguments: { path: "src/research.ts" } },
    { type: "toolCall" as const, id: "preview-read-b", name: "read", arguments: { path: "src/types.ts" } },
    { type: "toolCall" as const, id: "preview-shell", name: "bash", arguments: { purpose: "Verify the command output display", command: "printf '2 checks passed\\n'" } },
    { type: "toolCall" as const, id: "preview-shell-multiline", name: "bash", arguments: { purpose: "Check both research source files exist", command: "if test -f src/research.ts && test -f src/types.ts; then\n  printf '%s\\n' '2 source files ready'\nelse\n  printf '%s\\n' 'Missing source files'\nfi" } },
    ] : [{ type: "thinking" as const, thinking: "I will keep source metadata explicit and preserve the existing search contract." }, { type: "text" as const, text: "## Research workflow\n\nSearch results keep their source and date. A stable phrase across wraps remains searchable when the terminal narrows.\n\n```typescript src/research.ts\nconst sources = await search(query);\nreturn sources.map(({ title, url }) => ({ title, url }));\n```\n\n- Search and page extraction have separate controls.\n- Long commands stay visible in the transcript viewer." }],
    usage: { input: 3480, output: 240, cacheRead: 1800, cacheWrite: 0, totalTokens: 5520, cost: { input: 0.01044, output: 0.0036, cacheRead: 0.00054, cacheWrite: 0, total: 0.01458 } } };
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push(tool ? { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(message.content[0]), partial: message }
    : { type: "text_delta", contentIndex: 1, delta: "Research workflow", partial: message });
  void (async () => {
    if (!tool) {
      await delay(400);
      await writeFile(join(root, "phase"), "active");
      while (await readFile(join(root, "continue"), "utf8").catch(() => "") !== "yes") await delay(25);
    }
    stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
    stream.end();
  })().catch(async (error) => { await writeFile(join(root, "failure"), String(error)); });
  return stream;
};
await runtime.session.prompt("Improve the research workflow, then show a concise implementation example.");
await delay(300);
await writeFile(join(root, "result.json"), JSON.stringify({ errors, networkAttempts, extensions: paths.length }));
await writeFile(join(root, "phase"), "settled");
await mode.run();
