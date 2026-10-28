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
  expect(report.find((row) => row.id === "search-keys")?.detail).toContain("Exa public access; no API key required");
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

test("validates editor accents without exposing config contents", async () => {
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
    const report = formatReport(await diagnose({ ...input, agentDir: dir, commands: ["codex-prompt"] }, probe));
    expect(report).not.toContain("secret-invalid-value");
    expect(report).toContain("Repair codex-prompt.json");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Mistral credentials are reported as explicit-only without exposing their value", async () => {
  const report = await diagnose({ ...input, env: { MISTRAL_API_KEY: "mistral-secret" } }, good);
  const text = formatReport(report);
  expect(text).toContain("Mistral (explicit provider selection)");
  expect(text).not.toContain("mistral-secret");
});


test("host and access diagnostics use metadata without printing raw config or resolving credentials", async () => {
  const report = await diagnose({ ...input, hostVersion: "0.85.0", modelAuthConfigured: false, modelConfigInvalid: true, bindingConflicts: 2 }, good);
  for (const id of ["host-version", "model-auth", "model-config", "keybindings"]) expect(report.find((row) => row.id === id)?.status).toBe("warn");
  expect(report.find((row) => row.id === "search-keys")?.status).toBe("ok");
  for (const hostVersion of ["0.87.0", "1.0.3", "2.0.0", "1.0.0-beta.1"]) expect((await diagnose({ ...input, hostVersion }, good)).find((row) => row.id === "host-version")?.status).toBe("warn");
  for (const hostVersion of ["1.0.4", "1.2.0", "1.10.0"]) expect((await diagnose({ ...input, hostVersion }, good)).find((row) => row.id === "host-version")?.status).toBe("ok");
  const valid = await diagnose({ ...input, hostVersion: "1.0.4", modelAuthConfigured: true, modelConfigInvalid: false, bindingConflicts: 0, env: { EXA_API_KEY: "configured-key" } }, good);
  expect(valid.find((row) => row.id === "host-version")?.status).toBe("ok");
  expect(valid.find((row) => row.id === "search-keys")?.detail).toContain("API key after rate limits or access errors");
  expect(JSON.stringify(valid)).not.toContain("configured-key");
  const publicAccess = await diagnose({ ...input, env: {} }, good);
  expect(publicAccess.find((row) => row.id === "search-keys")?.detail).toContain("public access");
});

test("Mistral connector cache reports age and refresh failures without remote error text", async () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  const cache = { version: 1 as const, fetchedAt: now - 5 * 60_000, account: "a", connectors: [{ id: "1", alias: "notes", displayName: "Notes", ready: true, authAction: "none" as const, tools: [] }] };
  const run = async (state: Awaited<ReturnType<NonNullable<Probe["connectorCache"]>>>) =>
    (await diagnose({ ...input, now, commands: ["mistral-connectors"] }, { ...good, connectorCache: async () => state })).find((row) => row.id === "mistral-connectors");
  expect(await run(cache)).toMatchObject({ status: "ok", detail: expect.stringContaining("1 ready connector; list fetched 5 min ago") });
  const failed = await run({ ...cache, lastError: "HTTP 503 from /v1/connectors/bootstrap: private body" });
  expect(failed).toMatchObject({ status: "warn", detail: expect.stringContaining("last refresh failed (HTTP 503)") });
  expect(JSON.stringify(failed)).not.toContain("private body");
  expect((await run({ ...cache, fetchedAt: now - 3 * 86_400_000 }))?.status).toBe("warn");
  expect((await run("absent"))?.fix).toContain("/mistral-connectors refresh");
  expect((await diagnose({ ...input, commands: [] }, { ...good, connectorCache: async () => { throw new Error("unexpected"); } })).some((row) => row.id === "mistral-connectors")).toBe(false);
});

test("connector cache probe reads caches beyond the settings size cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-doctor-connectors-"));
  try {
    const probe = localProbe({ ...input, agentDir: dir });
    expect(await probe.connectorCache!()).toBe("absent");
    const connectors = Array.from({ length: 400 }, (_, i) => ({ id: String(i), alias: `c${i}`, displayName: "x".repeat(200), ready: false, authAction: "none", tools: [] }));
    await writeFile(join(dir, "mistral-connectors-cache.json"), JSON.stringify({ version: 1, fetchedAt: 1, account: "a", connectors }));
    expect(await probe.connectorCache!()).toMatchObject({ version: 1, connectors: { length: 400 } });
    await writeFile(join(dir, "mistral-connectors-cache.json"), JSON.stringify({ version: 2 }));
    expect(await probe.connectorCache!()).toBe("invalid");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("duplicate extension commands, stale enabled models and large sessions are reported", async () => {
  const settings: Probe = { ...good, settings: async () => ({ enabledModels: ["anthropic/claude:high", "gone/model", "openai/gpt", "anthropic/*", "sonnet", 42] }) };
  const status = (provider: string, id: string) => provider === "gone" ? "missing" as const : provider === "openai" ? "unauthenticated" as const : (expect(id).toBe("claude"), "ok" as const);
  const report = await diagnose({ ...input, commands: ["plan:1", "plan:2", "skill:review", "review", "notify"], modelStatus: status, session: { fileBytes: 30 * 1024 * 1024, entries: 12 } }, settings);
  expect(report.find((row) => row.id === "duplicate-commands")).toMatchObject({ status: "warn", detail: expect.stringContaining("/plan (2)") });
  expect(report.find((row) => row.id === "enabled-models")).toMatchObject({ status: "warn", detail: "Not found: gone/model. No configured authentication: openai/gpt." });
  expect(report.find((row) => row.id === "session-size")).toMatchObject({ status: "warn", detail: expect.stringContaining("Session file 30.0 MB, 12 entries") });

  const healthy = await diagnose({ ...input, commands: ["plan"], modelStatus: () => "ok", session: { entries: 3 } }, { ...good, settings: async () => ({ enabledModels: ["anthropic/claude"] }) });
  expect(healthy.find((row) => row.id === "duplicate-commands")?.status).toBe("ok");
  expect(healthy.find((row) => row.id === "enabled-models")).toMatchObject({ status: "ok", detail: expect.stringContaining("1 exact enabledModels entry resolves") });
  expect(healthy.find((row) => row.id === "session-size")).toMatchObject({ status: "ok", detail: "Not saved to a file, 3 entries." });
  // Without enabledModels or registry access, no model finding is invented.
  expect((await diagnose({ ...input, modelStatus: () => "ok" }, { ...good, settings: async () => ({}) })).some((row) => row.id === "enabled-models")).toBe(false);
});
