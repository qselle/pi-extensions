import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getModels } from "@earendil-works/pi-ai/compat";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { RpcAgentClient } from "./rpc.ts";
import { REPORT_MESSAGE_TYPE, REPORT_TOOL_NAME } from "./report.ts";
import { restoreAgents } from "./persistence.ts";
import type { SubagentCoordinator } from "./coordinator.ts";

const root = await mkdtemp(join(tmpdir(), "pi-child-report-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
let networkAttempts = 0;
globalThis.fetch = (() => { networkAttempts++; throw new Error("Report fixture forbids model/network calls"); }) as unknown as typeof fetch;
const model = getModels("anthropic")[0]!;
const sessions: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"][] = [];
async function makeSession(name: string, factory: (pi: ExtensionAPI) => void) {
  const manager = SessionManager.create(root, join(root, name));
  manager.appendMessage({ role: "user", content: "Persistent test session", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    timestamp: 2, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [factory] } });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model });
  sessions.push(session);
  await session.bindExtensions({ onError: (error) => { throw error; } });
  return { session, manager };
}
async function until(check: () => boolean) {
  for (let index = 0; index < 200; index++) { if (check()) return; await Bun.sleep(5); }
  throw new Error("Timed out waiting for native report delivery");
}
try {
  const child = await makeSession("child-tools", (pi) => {
    const previous = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "1";
    try { assert.equal(register(pi), undefined); }
    finally { if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previous; }
  });
  const childRunner = child.session.extensionRunner!;
  assert.equal(childRunner.getToolDefinition("subagents"), undefined, "children must not recursively spawn");
  const reporter = childRunner.getToolDefinition(REPORT_TOOL_NAME)!;
  assert(reporter);
  const childContext = childRunner.createContext();
  await assert.rejects(reporter.execute("empty", { message: " " }, undefined, undefined, childContext), /1–4000/);
  await assert.rejects(reporter.execute("large", { message: "x".repeat(4001) }, undefined, undefined, childContext), /1–4000/);
  await assert.rejects(reporter.execute("aborted", { message: "Actionable finding" }, AbortSignal.abort(), undefined, childContext));
  const reportResult = await reporter.execute("native-report", { message: "Use `runId` when acknowledging repeated child runs." }, undefined, undefined, childContext);

  const script = join(root, "rpc-report.mjs");
  await writeFile(script, `
import { createInterface } from "node:readline";
const report = ${JSON.stringify(reportResult)};
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  emit({ type: "response", id: request.id, command: request.type, success: true, data: {} });
  if (request.type === "prompt") setTimeout(() => {
    emit({ type: "tool_execution_start", toolName: "report_to_parent", toolCallId: "native-report", args: { message: report.details.report.message } });
    emit({ type: "tool_execution_end", toolName: "report_to_parent", toolCallId: "native-report", isError: false, result: report });
    emit({ type: "tool_execution_end", toolName: "report_to_parent", toolCallId: "native-report", isError: false, result: report });
  }, 25);
});
`);
  let coordinator!: SubagentCoordinator;
  let parentContext: unknown;
  const parent = await makeSession("parent", (pi) => {
    coordinator = register(pi, { createClient: (options) => {
      const active = options.args[options.args.indexOf("--tools") + 1]!.split(",");
      assert(active.includes(REPORT_TOOL_NAME)); assert(!active.includes("subagents"));
      return new RpcAgentClient({ command: process.execPath, args: [script], cwd: root });
    }, registerCard: (() => ({ invalidate() {}, unregister() {} })) as any })!;
    pi.on("session_start", (_event, ctx) => { parentContext = ctx; });
  });
  assert.equal(parent.session.extensionRunner!.getToolDefinition(REPORT_TOOL_NAME), undefined, "reporting is child-only");
  await coordinator.spawn({ name: "Reporter", task: "Audit child delivery", contextMode: "fresh", cwd: root, parentContext });
  const messages = () => parent.manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === REPORT_MESSAGE_TYPE);
  await until(() => messages().length === 1);
  await Bun.sleep(30);
  assert.equal(messages().length, 1, "duplicate RPC report events deliver once");
  assert.equal(parent.session.isStreaming, false);
  assert.equal(networkAttempts, 0, "an idle parent must not start a model turn for a report");
  assert.equal(restoreAgents(parent.manager.getBranch())[0]!.reports![0]!.delivery, "wait", "actual custom-message evidence acknowledges the report");
  await parent.session.reload();
  assert.equal(coordinator.list()[0]!.status, "stopped");
  assert.equal(coordinator.list()[0]!.reports?.length, 0);
  assert.equal(coordinator.read("Reporter").reports?.length, 1, "explicit read can retrieve a saved report again");

  await coordinator.spawn({ name: "Waited", task: "Return an interim finding", contextMode: "fresh", cwd: root, parentContext });
  const waited = await coordinator.wait(["Waited"], 1000, "any", undefined, "any");
  assert.equal(waited.timedOut, false);
  assert.equal(waited.agents[0]!.reports?.length, 1);
  await Bun.sleep(30);
  assert.equal(messages().length, 1, "wait-owned reports must not also emit a card");
  assert.equal(networkAttempts, 0);
  console.log("Native child-only reporting, RPC dedupe, safe idle delivery and restored unread state verified");
} finally {
  for (const session of sessions.reverse()) { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  await rm(root, { recursive: true, force: true });
}
