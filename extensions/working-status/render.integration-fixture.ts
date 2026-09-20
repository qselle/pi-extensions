import assert from "node:assert/strict";
import { CustomEditor, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { decorateCodexEditor } from "../codex-prompt/editor.ts";
import extension from "./index.ts";

// Test-only access to the installed host's actual working indicator. Production
// code uses ExtensionUIContext.setWorkingIndicator, never this implementation.
const { WorkingStatusIndicator } = await import(new URL("./modes/interactive/components/status-indicator.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
initTheme("dark", false);
const identity = (text: string) => text;
const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as any;
const theme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
const editor = decorateCodexEditor(new CustomEditor(tui, theme, { matches: () => false, getKeys: () => [] } as any, { embedWorkingStatus: true }), identity);
const indicator = new WorkingStatusIndicator(tui, "Working", undefined, identity);
editor.setWorkingStatusIndicator(indicator);
const handlers = new Map<string, Function>();
let command: any;
const entries: any[] = [];
const ctx = { mode: "tui", isIdle: () => true, sessionManager: { getBranch: () => entries }, ui: {
  notify() {}, setWorkingMessage: (message?: string) => indicator.setMessage(message ?? "Working"),
  setWorkingIndicator: (options?: unknown) => indicator.setIndicator(options),
} };
extension({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (_: string, value: any) => { command = value; },
  appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
} as never);
try {
  handlers.get("agent_start")!({}, ctx);
  for (const style of ["native", "pulse", "static", "text"]) {
    await command.handler(style, ctx);
    const initial = indicator.renderInBorder(80);
    assert(initial.includes("Waiting for model · 0s"));
    if (style === "static") assert(initial.startsWith("●"));
    if (style === "text") assert.equal(initial, "Waiting for model · 0s");
    if (style === "pulse") assert(initial.startsWith("·"));
    for (const width of [1, 8, 20, 40, 80]) {
      assert(editor.render(width).every((line) => visibleWidth(line) <= width));
    }
    if (style === "static" || style === "text") {
      await Bun.sleep(260);
      assert.equal(indicator.renderInBorder(80), initial);
    }
  }
  handlers.get("session_shutdown")!({}, ctx);
  assert(!indicator.renderInBorder(80).includes("Waiting for model"));
} finally {
  handlers.get("session_shutdown")!({}, ctx);
  indicator.dispose();
}
console.log("native working styles and editor bounds verified");
