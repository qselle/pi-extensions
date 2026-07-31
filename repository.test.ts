import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const extensionsRoot = join(import.meta.dir, "extensions");
const extensions = readdirSync(extensionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe.each(extensions)("%s repository contract", (name) => {
  const directory = join(extensionsRoot, name);

  test("has an entry point, focused tests, and dependency documentation", () => {
    expect(existsSync(join(directory, "index.ts"))).toBe(true);
    expect(readdirSync(directory).some((file) => file.endsWith(".test.ts"))).toBe(true);

    const readmePath = join(directory, "README.md");
    expect(existsSync(readmePath)).toBe(true);
    const readme = readFileSync(readmePath, "utf8");
    expect(readme.startsWith(`# ${name}\n`)).toBe(true);
    expect(readme).toMatch(/^## Dependencies(?: and (?:platform )?limitations)?$/m);
  });
});
