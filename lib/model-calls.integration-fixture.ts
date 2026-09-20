import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, type AssistantMessage, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { requestTitle } from "../extensions/session-title/request.ts";
import { summarizeParent } from "../extensions/subagents/context.ts";
import sideChat from "../extensions/side-chat/index.ts";

const root = await mkdtemp(join(tmpdir(), "pi-registry-calls-"));
process.env.PI_CODING_AGENT_DIR = root;
globalThis.fetch = (() => { throw new Error("Network forbidden"); }) as unknown as typeof fetch;
try {
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  const calls: { context: TranscriptContext; options?: SimpleStreamOptions }[] = [];
  let fail = false;
  registry.registerProvider("fixture-provider", {
    api: "fixture-api", baseUrl: "https://fixture.invalid", apiKey: "fixture-key", headers: { "x-fixture": "configured" },
    models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      assert.equal(options?.apiKey, "fixture-key");
      assert.equal(options?.headers?.["x-fixture"], "configured");
      assert.equal(model.baseUrl, "https://fixture.invalid");
      calls.push({ context, options });
      const stream = new AssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
        content: [{ type: "text", text: "Configured provider answer" }], stopReason: fail ? "error" : "stop", errorMessage: fail ? "fixture failure" : undefined,
        usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      if (fail) stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
  const model = registry.find("fixture-provider", "model")!;
  assert(model);
  const manager = SessionManager.inMemory(root);
  const ctx = { model, modelRegistry: registry, sessionManager: manager, hasUI: false, ui: { setStatus() {} } };
  const title = await requestTitle({ ctx, prompt: "Name this work" });
  assert.equal(title.title, "Configured provider answer");
  assert(getCurrentSystemPrompt(calls[0]!.context.messages).includes("Reply only"));
  assert.equal(calls[0]!.options?.maxTokens, 24);
  const messages = [{ role: "user", content: "Parent objective", timestamp: 0 }];
  assert.equal(await summarizeParent(ctx, messages), "Configured provider answer");
  assert(JSON.stringify(calls[1]!.context.messages).includes("Parent objective"));
  assert.equal(calls[1]!.options?.sessionId, `${manager.getSessionId()}:subagent-summary`);
  fail = true;
  await assert.rejects(summarizeParent(ctx, messages), /fixture failure/);
  fail = false;
  const controller = new AbortController(); controller.abort();
  const before = calls.length;
  await assert.rejects(summarizeParent(ctx, messages, controller.signal), /cancelled/);
  assert.equal(calls.length, before);

  const handlers = new Map<string, Function>();
  const store = sideChat({ on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, appendEntry() {}, events: { emit() {} } } as never,
    { titleConfig: { enabled: false }, registerCard: (() => ({ invalidate() {}, unregister() {} })) as never });
  handlers.get("session_start")!({}, ctx);
  const chat = store.create({ model, systemPrompt: "Side instructions", contextMode: "none" });
  store.send(chat.id, "Side question");
  for (let i = 0; i < 100 && chat.turns.at(-1)?.role !== "assistant"; i++) await Bun.sleep(10);
  assert.equal(chat.turns.at(-1)?.text, "Configured provider answer");
  assert.equal(getCurrentSystemPrompt(calls.at(-1)!.context.messages), "Side instructions");
  assert.equal(calls.at(-1)!.options?.sessionId, `${manager.getSessionId()}:side:${chat.id}`);
  handlers.get("session_shutdown")!({}, ctx);
  console.log("Configured provider used for title, summary and side chat without network");
} finally { await rm(root, { recursive: true, force: true }); }
