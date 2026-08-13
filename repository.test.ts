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

  test("has code, tests, and consistently formatted documentation", () => {
    expect(existsSync(join(directory, "index.ts"))).toBe(true);
    expect(readdirSync(directory).some((file) => file.endsWith(".test.ts"))).toBe(true);

    const readmePath = join(directory, "README.md");
    expect(existsSync(readmePath)).toBe(true);
    const readme = readFileSync(readmePath, "utf8");
    expect(readme.startsWith(`# ${name}\n`)).toBe(true);

    const sections = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    const expected = sections.includes("Configuration")
      ? ["Usage", "Configuration", "Dependencies and limitations"]
      : ["Usage", "Dependencies and limitations"];
    expect(sections).toEqual(expected);
  });
});
