import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertSearchRoot } from "./search-root.ts";

const base = mkdtempSync(join(tmpdir(), "pi-search-root-"));
const home = join(base, "home");
const project = join(home, "Work", "project");
mkdirSync(project, { recursive: true });
mkdirSync(join(home, "Library", "CloudStorage", "Drive", "notes"), { recursive: true });
symlinkSync(home, join(base, "alias"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const check = (path: unknown, cwd = project, cloudRoots = true) => assertSearchRoot("grep", path, cwd, { homeDir: home, cloudRoots });

test("rejects home, its ancestors and broad cloud roots", async () => {
  for (const path of ["~", home, dirname(home), "/", "~/Library", "~/Library/CloudStorage", "@~"]) {
    await expect(check(path)).rejects.toThrow("broad root");
  }
  await expect(check(undefined, home)).rejects.toThrow("broad root");
  await expect(check("..", join(home, "Work"))).rejects.toThrow("broad root");
});

test("allows specific projects, cloud subfolders and missing paths", async () => {
  for (const path of [undefined, ".", "~/Work/project", "~/Library/CloudStorage/Drive/notes", "missing/dir"]) {
    await expect(check(path)).resolves.toBeUndefined();
  }
  await expect(check("~/Library", project, false)).resolves.toBeUndefined();
});

test("rejects symlinked aliases of a broad root", async () => {
  await expect(check(join(base, "alias"))).rejects.toThrow("broad root");
  await expect(check(join(base, "alias", "Work", "project"))).resolves.toBeUndefined();
});
