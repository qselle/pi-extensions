import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import footerExtension from "./index.ts";

const response = (id: string, input: number, cost: number) =>
  ({ id, type: "message", message: { role: "assistant", usage: { input, output: 1, cost: { total: cost } } } });

function render(config?: string): string {
  const configPath = join(mkdtempSync(join(tmpdir(), "footer-")), "footer.json");
  if (config !== undefined) writeFileSync(configPath, config);
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  footerExtension({
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler),
    events: { on: () => () => {}, emit: () => {} },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  } as never, { configPath });
  const active = [response("a", 100, 0.1)];
  const abandoned = response("b", 2000, 2);
  let factory: any;
  const ctx = {
    mode: "tui", cwd: "/work/project", isIdle: () => true, getContextUsage: () => undefined,
    sessionManager: { getLeafId: () => "a", getBranch: () => active, getEntries: () => [...active, abandoned], getSessionId: () => "session" },
    ui: { setTitle() {}, setFooter: (value: unknown) => { factory = value; } },
  };
  handlers.get("session_start")!({}, ctx);
  const line = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, undefined).render(300)[0];
  handlers.get("session_shutdown")!({}, ctx);
  return line;
}

test("usage totals follow the active branch unless footer.json opts into the whole session", () => {
  for (const config of [undefined, "{not json", JSON.stringify({ totals: "branch" })]) {
    const line = render(config);
    expect(line).toContain("in 100 out 1");
    expect(line).toContain("$0.10");
  }
  const session = render(JSON.stringify({ totals: "session" }));
  expect(session).toContain("in 2.1K out 2");
  expect(session).toContain("$2.10");
});
