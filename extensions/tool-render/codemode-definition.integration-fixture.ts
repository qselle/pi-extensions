/** The restyled codemode keeps every field of Pi's built-in definition in a real session. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai/compat";
import { createAgentSessionFromServices, createAgentSessionServices, createCodemodeExtension, SessionManager, SettingsManager, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";

const root = await mkdtemp(join(tmpdir(), "pi-tool-render-codemode-definition-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.ANTHROPIC_API_KEY = "fixture-not-a-real-key";
globalThis.fetch = (() => { throw new Error("Network forbidden"); }) as unknown as typeof fetch;
try {
  const { INTENT_GUIDELINE } = await import("./codemode.ts");
  let builtin!: ToolDefinition<any, any> & { defaultActive?: boolean };
  createCodemodeExtension()({ registerTool: (tool: typeof builtin) => { builtin = tool; }, getSettings: () => ({}) } as unknown as ExtensionAPI);
  let api!: ExtensionAPI;
  const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    resourceLoaderOptions: { noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      // Loaded the way the CLI loads them: package paths precede `builtin:` paths.
      additionalExtensionPaths: [import.meta.dir],
      extensionFactories: [{ name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true }, (pi) => { api = pi; }] } });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(root), model: getModels("anthropic")[0]! });
  await session.bindExtensions({});

  const info = api.getAllTools().find((tool) => tool.name === "codemode");
  assert(info, "the built-in codemode extension loaded");
  assert(!info.sourceInfo.path.startsWith("builtin:"), "tool-render replaced the definition");
  // The MCP extension activates a replacement codemode for MCP tools only when it declares reachesTools.
  assert.equal(typeof info.reachesTools, "function");
  assert.equal(info.exposure, builtin.exposure);
  assert(!api.getActiveTools().includes("codemode"), "default activation stays Pi's");

  const restyled = session.extensionRunner.getToolDefinition("codemode") as typeof builtin;
  const own = new Set(["renderShell", "renderCall", "renderResult", "promptGuidelines"]);
  for (const key of Object.keys(builtin) as (keyof typeof builtin)[]) {
    if (own.has(key)) continue;
    const value = builtin[key];
    if (typeof value === "function") assert.equal(typeof restyled[key], "function", `${key} survives`);
    else assert.deepEqual(restyled[key], value, `${key} survives`);
  }
  for (const code of ["return 1", "await tools.mcp__docs__search({})", "await searchTools('x')"]) {
    assert.deepEqual(restyled.reachesTools!({ code }), builtin.reachesTools!({ code }));
  }
  assert.deepEqual(restyled.promptGuidelines, [...(builtin.promptGuidelines ?? []), INTENT_GUIDELINE]);
  assert.equal(restyled.renderShell, "self");
  session.dispose();
  console.log("restyled codemode keeps Pi's definition");
} finally { await rm(root, { recursive: true, force: true }); }
