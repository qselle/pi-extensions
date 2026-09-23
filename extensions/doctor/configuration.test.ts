import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { diagnose, formatReport, localProbe, type DoctorInput } from "./checks.ts";
import { resourceFindings } from "./configuration.ts";

test("resource lists accept Pi filters and preserve ordered include/exclude rules", async () => {
  const findings = await resourceFindings({
    packages: ["npm:test", { source: "git:github.com/example/package", autoload: false, extensions: [], skills: ["!**", "+selected/SKILL.md"] }],
    extensions: ["+optional.ts", "-optional.ts", "+optional.ts", "**/*.ts", "**/*.ts"], skills: [], prompts: [], themes: [],
    unrelatedFutureSetting: { anything: true },
  }, "/unused");
  expect(findings).toHaveLength(1);
  expect(findings[0]?.status).toBe("ok");
});

test("malformed resource settings identify only fields and never expose their values", async () => {
  const findings = await resourceFindings({ packages: [42, null, [], { source: "", autoload: "secret", themes: "secret-path" }, { source: "npm:private", prompts: [true] }],
    extensions: "secret-location", skills: [42], prompts: [""], themes: {} }, "/unused");
  const text = formatReport(findings);
  expect(findings[0]?.status).toBe("warn");
  expect(text).toContain("packages[3].source");
  expect(text).toContain("and 3 more");
  for (const value of ["secret", "npm:private", "/unused"]) expect(text).not.toContain(value);
  expect((await resourceFindings({ packages: {} }, "/unused"))[0]?.detail).toContain("packages");
});

test("duplicate package selections are detected across string/object forms and local path aliases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-doctor-resources-"));
  try {
    const findings = await resourceFindings({
      packages: ["npm:private-package", { source: "npm:private-package", extensions: [] }, dir, { source: "." }],
      extensions: [dir, pathToFileURL(dir).href, "opaque-entry.ts", "opaque-entry.ts"],
      themes: ["!*.json", "+selected.json", "!*.json"],
    }, dir);
    expect(findings.find((row) => row.id === "resource-duplicates")?.detail).toContain("extensions: 2; packages: 2");
    expect(findings.some((row) => row.id === "resource-missing")).toBe(false);
    const text = formatReport(findings);
    for (const value of [dir, "private-package", "opaque-entry"]) expect(text).not.toContain(value);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing checks inspect only explicit local entries and resolve global relative paths from agentDir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-doctor-resources-"));
  try {
    await mkdir(join(dir, "present"));
    await symlink(join(dir, "present"), join(dir, "linked"));
    const findings = await resourceFindings({
      packages: ["./present", "./linked", "./missing", "npm:uninstalled", "git:github.com/example/absent", "bare-package", { source: "./present", extensions: ["missing.ts"] }],
      extensions: ["./missing-extension.ts", "+./not-present.ts", "!./not-present.ts", "./*.ts", "./[abc].ts", "./{a,b}.ts"],
      prompts: [pathToFileURL(join(dir, "missing-prompt.md")).href],
    }, dir);
    expect(findings.find((row) => row.id === "resource-missing")?.detail).toContain("extensions: 1; prompts: 1; packages: 1");
    expect(formatReport(findings)).not.toContain(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("doctor resource diagnostics share the bounded settings read and reject symlinked settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-doctor-resources-"));
  const input: DoctorInput = { platform: process.platform, bun: false, env: {}, agentDir: dir, tools: [], activeTools: [], commands: [], telegram: "disabled" };
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({ packages: ["npm:sensitive", "npm:sensitive"], skills: false }));
    const report = formatReport(await diagnose(input));
    expect(report).toContain("Repeated resource entries");
    expect(report).toContain("Malformed resource fields: skills");
    expect(report).not.toContain("sensitive");
    const probe = localProbe(input);
    expect(await probe.config("settings.json")).toBe("valid");
    await writeFile(join(dir, "settings.json"), "{}");
    expect((await probe.resources!()).some((row) => row.id === "resource-duplicates")).toBe(true);
    await rm(join(dir, "settings.json"));
    await writeFile(join(dir, "other.json"), "{}");
    await symlink(join(dir, "other.json"), join(dir, "settings.json"));
    const unsafe = await diagnose(input);
    expect(unsafe.find((row) => row.id === "host-settings")?.status).toBe("warn");
    expect(unsafe.some((row) => row.id === "resource-settings")).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
