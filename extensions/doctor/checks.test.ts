import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose, formatReport, localProbe, type DoctorInput, type Probe } from "./checks.ts";

const input: DoctorInput = { platform: "darwin", bun: false, env: {}, agentDir: "/unused", tools: ["web_search", "web_read", "job_start"], activeTools: ["web_search", "web_read", "job_start"], commands: ["telegram", "notify", "tool-render", "prevent-sleep"], telegram: "disabled", shell: "/bin/bash" };
const good: Probe = { executable: async () => true, config: async () => "absent", pty: async () => true };

test("missing keys and tools produce actionable findings without secret output", async () => {
  const report = await diagnose({ ...input, env: { EXA_API_KEY: "super-secret-value", PATH: "/private-value" }, activeTools: ["job_start"], telegram: "invalid" }, { ...good, executable: async (name) => name !== "ax" });
  const text = formatReport(report);
  expect(text).toContain("credentials present; validity not tested");
  expect(text).toContain("ax is missing");
  expect(text).toContain("loaded but inactive");
  expect(text).toContain("/telegram setup");
  expect(text).not.toContain("super-secret-value");
  expect(text).not.toContain("/private-value");
});

test("unloaded optional integrations do not trigger configuration probes", async () => {
  const probe: Probe = { ...good, config: async (name) => { expect(name).toBe("settings.json"); return "absent"; }, pty: async () => { throw new Error("unexpected"); } };
  const report = await diagnose({ ...input, tools: [], activeTools: [], commands: [] }, probe);
  expect(report.filter((row) => row.status === "warn")).toEqual([]);
  expect(report.some((row) => row.id === "telegram")).toBe(false);
});

test("Bun PTY limitations do not attempt native probing", async () => {
  const report = await diagnose({ ...input, bun: true }, { ...good, pty: async () => { throw new Error("unexpected"); } });
  expect(report.find((row) => row.id === "pty")?.fix).toContain("Node.js");
});

test("Linux skips sleep helper checks while retaining desktop notification checks", async () => {
  const probed: string[] = [];
  const report = await diagnose({ ...input, platform: "linux", env: { DISPLAY: ":0" }, tools: [], activeTools: [] }, {
    ...good, executable: async (name) => { probed.push(name); return true; },
  });
  expect(probed).toEqual(["/bin/bash", "notify-send"]);
  expect(report.find((row) => row.id === "prevent-sleep")?.status).toBe("off");
  expect(report.find((row) => row.id === "prevent-sleep")?.fix).toBeUndefined();
  expect(report.find((row) => row.id === "notify")?.status).toBe("ok");
});

test("terminal notification support does not require a desktop helper on the Pi host", async () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    for (const env of [{ TERM_PROGRAM: "ghostty" }, { TERM: "xterm-ghostty", TMUX: "session" }, { TERM_PROGRAM: "WezTerm" }, { TERM_PROGRAM: "iTerm.app" }]) {
      const probed: string[] = [];
      const report = await diagnose({ ...input, platform, env, tools: [], activeTools: [], commands: ["notify"] }, {
        ...good, executable: async (name) => { probed.push(name); return true; },
      });
      expect(probed).toEqual(["/bin/bash"]);
      expect(report.find((row) => row.id === "notify")?.status).toBe("ok");
      expect(report.find((row) => row.id === "notify")?.detail).toContain("delivery are not tested");
      expect(report.find((row) => row.id === "notify")?.fix).toBeUndefined();
    }
  }
});

test("headless Linux diagnostics do not prescribe desktop notification packages", async () => {
  const probed: string[] = [];
  const report = await diagnose({ ...input, platform: "linux", env: { SSH_CONNECTION: "vm connection" }, tools: [], activeTools: [], commands: ["notify"] }, {
    ...good, executable: async (name) => { probed.push(name); return true; },
  });
  expect(probed).toEqual(["/bin/bash"]);
  expect(report.find((row) => row.id === "notify")?.status).toBe("off");
  expect(report.find((row) => row.id === "notify")?.detail).toContain("terminal bell");
  expect(report.find((row) => row.id === "notify")?.fix).toBeUndefined();
});

test("keyless search is configured while invalid settings and Windows limitations remain visible", async () => {
  const report = await diagnose({ ...input, platform: "win32", shell: undefined }, { ...good, config: async () => "invalid" });
  expect(report.find((row) => row.id === "search-keys")?.status).toBe("ok");
  expect(report.find((row) => row.id === "search-keys")?.detail).toContain("Exa keyless; no API key required");
  expect(report.find((row) => row.id === "search-keys")?.fix).toBeUndefined();
  expect(report.find((row) => row.id === "config-notify")?.status).toBe("warn");
  expect(report.find((row) => row.id === "cleanup")?.status).toBe("warn");
  expect(report.find((row) => row.id === "notify")?.status).toBe("off");
  expect(report.find((row) => row.id === "shell")?.status).toBe("warn");
});

test("filesystem probes bound JSON, reject unsafe files, and never execute found commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-doctor-"));
  try {
    const probe = localProbe({ ...input, env: { PATH: dir }, agentDir: dir });
    expect(await probe.config("notify.json")).toBe("absent");
    await writeFile(join(dir, "notify.json"), '{"enabled":false}');
    expect(await probe.config("notify.json")).toBe("valid");
    for (const content of ['{"enabled":"false"}', "[1]", "null", "{invalid", " ".repeat(65537)]) {
      await writeFile(join(dir, "notify.json"), content);
      expect(await probe.config("notify.json")).toBe("invalid");
    }
    await symlink(join(dir, "notify.json"), join(dir, "tool-render.json"));
    expect(await probe.config("tool-render.json")).toBe("invalid");
    await mkdir(join(dir, "directory"));
    expect(await probe.executable("directory")).toBe(false);
    await writeFile(join(dir, "ax"), '#!/bin/sh\nexit 99\n');
    await chmod(join(dir, "ax"), 0o700);
    expect(await probe.executable("ax")).toBe(true);
    await chmod(join(dir, "ax"), 0o600);
    expect(await probe.executable("ax")).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("optional context tools are off rather than broken and provider gates are explicit", async () => {
  const report = await diagnose({ ...input, tools: ["history_image", "context_notes"], activeTools: [], commands: ["fast"], model: { provider: "other", api: "openai-responses", id: "model", baseUrl: "https://proxy.test/v1" } }, good);
  expect(report.find((row) => row.id === "opt-in-history_image")?.status).toBe("off");
  expect(report.find((row) => row.id === "opt-in-context_notes")?.detail).toContain("/context-journal status");
  expect(report.find((row) => row.id === "fast-mode")?.status).toBe("off");
  const supported = await diagnose({ ...input, commands: ["fast"], model: { provider: "openai", api: "openai-responses", id: "model", baseUrl: "https://api.openai.com/v1" } }, good);
  expect(supported.find((row) => row.id === "fast-mode")?.detail).toContain("eligibility and actual tier are not tested");
});

test("validates editor accents and hyperlink modes without exposing config contents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-doctor-ui-"));
  try {
    const probe = localProbe({ ...input, agentDir: dir });
    for (const accent of ["theme", "thinking", "#abc", "#83a598"]) {
      await writeFile(join(dir, "codex-prompt.json"), JSON.stringify({ accent }));
      expect(await probe.config("codex-prompt.json")).toBe("valid");
    }
    for (const accent of ["secret-invalid-value", 42, "#ggg"]) {
      await writeFile(join(dir, "codex-prompt.json"), JSON.stringify({ accent }));
      expect(await probe.config("codex-prompt.json")).toBe("invalid");
    }
    await writeFile(join(dir, "hyperlinks.json"), JSON.stringify({ mode: "always" }));
    expect(await probe.config("hyperlinks.json")).toBe("valid");
    await writeFile(join(dir, "hyperlinks.json"), JSON.stringify({ mode: "secret-invalid-value" }));
    expect(await probe.config("hyperlinks.json")).toBe("invalid");
    const report = formatReport(await diagnose({ ...input, agentDir: dir, commands: ["codex-prompt", "hyperlinks"] }, probe));
    expect(report).not.toContain("secret-invalid-value");
    expect(report).toContain("Repair codex-prompt.json");
    expect(report).toContain("Repair hyperlinks.json");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Mistral credentials are reported as explicit-only without exposing their value", async () => {
  const report = await diagnose({ ...input, env: { MISTRAL_API_KEY: "mistral-secret" } }, good);
  const text = formatReport(report);
  expect(text).toContain("Mistral (explicit provider selection)");
  expect(text).not.toContain("mistral-secret");
});


test("host and access diagnostics use metadata without printing raw config or resolving credentials", async () => {
  const report = await diagnose({ ...input, hostVersion: "0.85.0", modelAuthConfigured: false, modelConfigInvalid: true, bindingConflicts: 2, env: { PI_EXA_ACCESS: "api-key" } }, good);
  for (const id of ["host-version", "model-auth", "model-config", "keybindings", "search-keys"]) expect(report.find((row) => row.id === id)?.status).toBe("warn");
  const valid = await diagnose({ ...input, hostVersion: "0.85.1", modelAuthConfigured: true, modelConfigInvalid: false, bindingConflicts: 0, env: { EXA_API_KEY: "present-but-unused" } }, good);
  expect(valid.find((row) => row.id === "search-keys")?.detail).toContain("keyless");
  expect(JSON.stringify(valid)).not.toContain("present-but-unused");
});
