import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import usageExport, { parseExportCommand } from "./index.ts";

test("parses explicit scopes, formats, and paths with spaces", () => {
  expect(parseExportCommand('branch csv "my report.csv"')).toEqual({ scope: "branch", format: "csv", path: "my report.csv" });
  expect(parseExportCommand("session json")).toEqual({ scope: "session", format: "json", path: undefined });
  expect(parseExportCommand("all xml file")).toBeUndefined();
  expect(parseExportCommand("branch json file\nother")).toBeUndefined();
});
test("exports only the selected scope, previews without writes and refuses files or symlinks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-usage-export-"));
  try {
    let command: any;
    usageExport({ registerCommand: (_name: string, value: any) => { command = value; } } as any);
    const record = (id: string) => ({ id, type: "message", message: { role: "assistant", usage: { input: 2 } } });
    const notices: string[] = [];
    const ctx = { cwd, sessionManager: { getBranch: () => [record("branch")], getEntries: () => [record("branch"), record("other")] }, ui: { notify: (message: string) => notices.push(message) } };
    await command.handler("branch json", ctx);
    expect(notices.at(-1)).toContain("1 usage records");
    expect(notices.at(-1)).toContain("1 unknown");
    await command.handler('branch json "branch usage.json"', ctx);
    const branch = JSON.parse(await readFile(join(cwd, "branch usage.json"), "utf8"));
    expect(branch.rows.map((row: any) => row.entryId)).toEqual(["branch"]);
    if (process.platform !== "win32") expect((await stat(join(cwd, "branch usage.json"))).mode & 0o777).toBe(0o600);
    await command.handler("session csv all.csv", ctx);
    expect(await readFile(join(cwd, "all.csv"), "utf8")).toContain('"other"');
    await writeFile(join(cwd, "existing"), "keep");
    await command.handler("branch json existing", ctx);
    expect(notices.at(-1)).toContain("already exists");
    expect(await readFile(join(cwd, "existing"), "utf8")).toBe("keep");
    await symlink(join(cwd, "existing"), join(cwd, "link"));
    await command.handler("branch json link", ctx);
    expect(notices.at(-1)).toContain("already exists");
    expect(await readFile(join(cwd, "existing"), "utf8")).toBe("keep");
    await command.handler("branch json missing/file", ctx);
    expect(notices.at(-1)).toContain("Could not create");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
