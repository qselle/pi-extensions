import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import footer, { FOOTER_BADGE_EVENT, TERMINAL_TITLE_OVERRIDE_EVENT } from "./index.ts";
import { SUBAGENT_USAGE_EVENT } from "../subagents/usage.ts";

const root = await mkdtemp(join(tmpdir(), "pi-footer-reload-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const counts = new Map<string, number>();
const events = [SUBAGENT_USAGE_EVENT, FOOTER_BADGE_EVENT, TERMINAL_TITLE_OVERRIDE_EVENT];
let emit!: (name: string, data: unknown) => void;
let component: { dispose?(): void } | undefined;
let renders = 0; const titles: string[] = [];
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
try {
  const install = (pi: ExtensionAPI) => {
    emit = (name, data) => pi.events.emit(name, data);
    footer({ ...pi, exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }), events: {
      emit: pi.events.emit,
      on: (name, listener) => {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        const off = pi.events.on(name, listener); let active = true;
        return () => { if (!active) return; active = false; counts.set(name, counts.get(name)! - 1); off(); };
      },
    } });
  };
  const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({}),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, extensionFactories: [install] } });
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(root), noTools: "all" }));
  const errors: string[] = [];
  await session.bindExtensions({ mode: "tui", onError: error => errors.push(error.error), uiContext: {
    ...session.extensionRunner.getUIContext(),
    setTitle: title => titles.push(title),
    setFooter: factory => {
      component?.dispose?.(); component = undefined;
      if (factory) component = factory({ requestRender: () => { renders++; } } as never, theme as never,
        { onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() } as never);
    },
  } });
  for (let index = 0; index < 5; index++) {
    for (const name of events) assert.equal(counts.get(name), 1, `${name} keeps one listener after reload ${index}`);
    const before = renders;
    emit(SUBAGENT_USAGE_EVENT, undefined);
    emit(FOOTER_BADGE_EVENT, { id: "fixture", text: "working" });
    assert.equal(renders, before + 2, "each bus event reaches only the current footer");
    emit(TERMINAL_TITLE_OVERRIDE_EVENT, { source: "fixture", title: `Reload ${index}` });
    assert.equal(titles.at(-1), `Reload ${index}`);
    await session.reload();
  }
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  for (const name of events) assert.equal(counts.get(name), 0, `${name} releases its shared-bus listener on quit`);
  const before = renders; const titleCount = titles.length;
  emit(SUBAGENT_USAGE_EVENT, undefined); emit(FOOTER_BADGE_EVENT, { id: "late", text: "late" });
  emit(TERMINAL_TITLE_OVERRIDE_EVENT, { source: "late", title: "stale" });
  assert.equal(renders, before); assert.equal(titles.length, titleCount);
  assert.deepEqual(errors, []);
  console.log("native footer reload releases and renews every shared-bus listener exactly once");
} finally { session?.dispose(); await rm(root, { recursive: true, force: true }); }
