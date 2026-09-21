import { exaAccess } from "../web-search/access.ts";
import { access, lstat, open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { parseAccent } from "../codex-prompt/config.ts";
import { supportsFastMode } from "../fast-mode/index.ts";
import { notificationEscape } from "../notify/deliver.ts";

export interface Finding { id: string; label: string; status: "ok" | "warn" | "off"; detail: string; fix?: string }
export interface DoctorInput {
  hostVersion?: string; modelAuthConfigured?: boolean; modelConfigInvalid?: boolean; bindingConflicts?: number;
  platform: NodeJS.Platform; bun: boolean; env: NodeJS.ProcessEnv; agentDir: string;
  tools: readonly string[]; activeTools: readonly string[]; commands: readonly string[];
  telegram: "enabled" | "disabled" | "invalid"; shell?: string;
  model?: { provider: string; api: string; id: string; baseUrl: string };
}
export interface Probe {
  executable(name: string): Promise<boolean>;
  config(name: string): Promise<"absent" | "valid" | "invalid">;
  pty(): Promise<boolean>;
}

/** Metadata checks only: no executable is launched and no network is contacted. */
export function localProbe(input: DoctorInput): Probe {
  return {
    async executable(name) {
      const paths = isAbsolute(name) ? [name] : (input.env.PATH ?? "").split(delimiter).filter(Boolean).map((part) => join(part, name));
      const candidates = input.platform === "win32" ? paths.flatMap((path) => [path, ...[".exe", ".cmd", ".bat"].map((ext) => path + ext)]) : paths;
      for (const path of candidates) {
        try { await access(path, input.platform === "win32" ? constants.F_OK : constants.X_OK); if (!(await stat(path)).isFile()) continue; return true; }
        catch { /* Try remaining PATH entries without disclosing paths/errors. */ }
      }
      return false;
    },
    async config(name) {
      const path = join(input.agentDir, name);
      let file;
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.size > 64 * 1024) return "invalid";
        file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 64 * 1024) return "invalid";
        const bytes = Buffer.alloc(64 * 1024 + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 64 * 1024) return "invalid";
        const data = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
        if (!data || typeof data !== "object" || Array.isArray(data)) return "invalid";
        if (name === "hyperlinks.json") return data.mode === undefined || ["auto", "always", "never"].includes(data.mode) ? "valid" : "invalid";
        if (name === "codex-prompt.json" && data.accent !== undefined && (typeof data.accent !== "string" || !parseAccent(data.accent))) return "invalid";
        const fields = name === "notify.json" ? ["enabled", "banner", "bell"] : ["enabled"];
        return fields.every((key) => data[key] === undefined || typeof data[key] === "boolean") ? "valid" : "invalid";
      } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid"; }
      finally { await file?.close(); }
    },
    async pty() {
      try {
        const require = createRequire(import.meta.url);
        const root = dirname(require.resolve("node-pty/package.json"));
        if (input.platform !== "darwin") return true;
        const helpers = [join(root, "prebuilds", `darwin-${process.arch}`, "spawn-helper"), join(root, "build", "Release", "spawn-helper")];
        for (const path of helpers) { try { await access(path, constants.X_OK); return true; } catch {} }
        return false;
      } catch { return false; }
    },
  };
}

export async function diagnose(input: DoctorInput, probe = localProbe(input)): Promise<Finding[]> {
  const result: Finding[] = [];
  const add = (id: string, label: string, status: Finding["status"], detail: string, fix?: string) => result.push({ id, label, status, detail, ...(fix ? { fix } : {}) });
  const loaded = (name: string) => input.tools.includes(name);
  const active = (name: string) => input.activeTools.includes(name);
  add("runtime", "Runtime", "ok", `${input.bun ? "Bun" : "Node.js"} on ${input.platform}.`);
  if (input.hostVersion) add("host-version", "Pi host", /^0\.87\.(?:0|[1-9]\d*)$/.test(input.hostVersion) ? "ok" : "warn", `Version ${input.hostVersion}; supported line is 0.87.x (minimum 0.87.0).`, /^0\.87\.(?:0|[1-9]\d*)$/.test(input.hostVersion) ? undefined : "Use the supported Pi host line and reload.");
  if (input.modelConfigInvalid !== undefined) add("model-config", "Model configuration", input.modelConfigInvalid ? "warn" : "ok", input.modelConfigInvalid ? "Pi reports a model configuration error; raw configuration is not displayed." : "Pi's model registry reports no configuration error.", input.modelConfigInvalid ? "Repair models.json, then reload Pi." : undefined);
  if (input.modelAuthConfigured !== undefined) add("model-auth", "Current model authentication", input.modelAuthConfigured ? "ok" : "warn", input.modelAuthConfigured ? "Authentication is configured according to Pi metadata; validity and balance are not tested." : "Pi reports no configured authentication for the selected model.", input.modelAuthConfigured ? undefined : "Use /login or configure the provider, then select the model again.");
  if (input.bindingConflicts !== undefined) add("keybindings", "Custom key assignments", input.bindingConflicts ? "warn" : "ok", input.bindingConflicts ? `${input.bindingConflicts} duplicate custom key assignment(s) reported by Pi; some may be intentional in separate UI contexts.` : "Pi reports no duplicate custom key assignments.", input.bindingConflicts ? "Review keybindings.json and keep intended context-specific overlaps." : undefined);
  const hostSettings = await probe.config("settings.json");
  add("host-settings", "Host settings", hostSettings === "invalid" ? "warn" : "ok", hostSettings === "invalid" ? "Global settings JSON is unreadable, oversized or malformed." : hostSettings === "absent" ? "No global settings file; defaults apply." : "Global settings JSON is readable; values and project overrides are not exhaustively validated.", hostSettings === "invalid" ? "Repair settings.json in the Pi agent directory." : undefined);
  const shellFound = !!input.shell && await probe.executable(input.shell);
  add("shell", "Shell", shellFound ? "ok" : "warn", shellFound ? "Pi resolved an available shell executable." : "Pi could not resolve an available shell executable.", shellFound ? undefined : "Install bash and make it available to Pi, then restart.");
  for (const [name, label] of [["web_search", "Web search"], ["web_read", "Page reader"], ["job_start", "Managed jobs"]]) {
    const status = !loaded(name!) ? "off" : active(name!) || name === "job_start" && active("bash") ? "ok" : "warn";
    add(`tool-${name}`, label!, status, status === "off" ? "Extension tool is not loaded." : status === "warn" ? "Tool is loaded but inactive for this agent." : name === "job_start" ? "Managed bash is active; job controls activate when needed." : "Tool is loaded and active.", status === "warn" ? "Enable this tool in your active tool selection." : undefined);
  }
  const providers = [input.env.EXA_API_KEY?.trim() ? "Exa" : "", input.env.FIRECRAWL_API_KEY?.trim() ? "Firecrawl (explicit provider selection)" : "", input.env.MISTRAL_API_KEY?.trim() ? "Mistral (explicit provider selection)" : ""].filter(Boolean);
  if (loaded("web_search")) {
    try {
      const access = exaAccess(input.env);
      add("search-keys", "Search access", "ok", `${access === "api-key" ? "Default: Exa API key (explicit setting)." : "Default: Exa keyless; no API key required."} Connectivity and rate limits are not tested.${providers.length ? ` ${providers.join(" and ")} credentials present; validity not tested.` : ""}`);
    } catch { add("search-keys", "Search access", "warn", "Exa access policy is invalid or explicitly selected account access lacks a key.", "Set PI_EXA_ACCESS=keyless, or api-key with EXA_API_KEY."); }
  }
  if (loaded("web_read")) {
    const found = await probe.executable("ax");
    add("ax", "ax page reader", found ? "ok" : "warn", found ? "Executable found on PATH; version and network access not tested." : "ax is missing from PATH.", found ? undefined : "Install ax using https://ax.yusuke.run/ and restart Pi with its directory on PATH.");
  }
  if (loaded("job_start")) {
    const pty = !input.bun && await probe.pty();
    add("pty", "Interactive terminals", pty ? "ok" : "warn", input.bun ? "PTY jobs are unavailable under Bun; pipe jobs work." : pty ? "PTY package/helper found; native loading and terminal launch not tested." : "PTY package or executable helper is missing.", pty ? undefined : input.bun ? "Launch Pi with Node.js for pty=true jobs." : "Reinstall package dependencies with install scripts enabled; on macOS run node scripts/prepare-pty.mjs from the package root.");
    add("cleanup", "Process cleanup", input.platform === "win32" ? "warn" : "ok", input.platform === "win32" ? "Windows cleanup is best effort and has not been verified on a Windows host." : "POSIX process-group cleanup is available; detached/escaped processes are outside that guarantee.");
  }
  if (input.commands.includes("telegram")) add("telegram", "Telegram configuration", input.telegram === "invalid" ? "warn" : input.telegram === "disabled" ? "off" : "ok", input.telegram === "enabled" ? "Local configuration validated; credentials and delivery not tested." : input.telegram === "disabled" ? "Optional Telegram service is disabled." : "Configuration is invalid or its file cannot be read securely.", input.telegram === "invalid" ? "Use /telegram setup; check owner-only file permissions and environment overrides." : undefined);
  for (const name of ["notify", "tool-render", "codex-prompt", "hyperlinks"]) if (input.commands.includes(name)) {
    const status = await probe.config(`${name}.json`);
    add(`config-${name}`, `${name} settings`, status === "invalid" ? "warn" : "ok", status === "absent" ? "No settings file; defaults apply." : status === "valid" ? "Settings are valid." : "Settings are unreadable, oversized, or invalid; extension defaults may apply.", status === "invalid" ? `Repair ${name}.json in the Pi agent directory and /reload.` : undefined);
  }
  for (const [tool, command, label] of [["history_image", "image-history", "Image history"], ["context_notes", "context-journal", "Context journal"]]) {
    if (!loaded(tool!)) continue;
    add(`opt-in-${tool}`, label!, active(tool!) ? "ok" : "off", active(tool!) ? `Tool is active; use /${command} status to inspect the session policy.` : `Optional tool is inactive. Use /${command} status to inspect the session policy.`, undefined);
  }
  if (input.commands.includes("fast")) {
    const supported = supportsFastMode(input.model);
    add("fast-mode", "Fast processing", supported ? "ok" : "off", supported ? "Current endpoint supports the extension's request control; use /fast status. Account eligibility and actual tier are not tested." : "Current model or endpoint is outside this extension's supported transport. No fast-mode override is applied here.");
  }
  for (const [command, binary, label] of [["notify", input.platform === "darwin" ? "/usr/bin/osascript" : "notify-send", "Desktop banners"], ["prevent-sleep", "/usr/bin/caffeinate", "Sleep prevention"]]) {
    if (!input.commands.includes(command!)) continue;
    if (command === "notify") {
      if (notificationEscape(input.env, "pi", "")) {
        add(command, label!, "ok", "Notifications use this terminal's OSC support; no native helper is required. Terminal permissions and delivery are not tested.");
        continue;
      }
      if (input.platform === "linux" && ![input.env.DISPLAY, input.env.WAYLAND_DISPLAY, input.env.DBUS_SESSION_BUS_ADDRESS].some((value) => value?.trim())) {
        add(command, label!, "off", "No Linux desktop environment is advertised; native banners are not checked. The terminal bell remains available where supported.");
        continue;
      }
    }
    if (command === "prevent-sleep" && input.platform !== "darwin") { add(command, label!, "off", "Sleep prevention is macOS-only."); continue; }
    if (!["darwin", "linux"].includes(input.platform)) { add(command!, label!, "off", "This integration has no native helper on this platform."); continue; }
    const found = await probe.executable(binary!);
    add(command!, label!, found ? "ok" : "warn", found ? "Platform helper found; permissions and service availability not tested." : "Platform helper is missing.", found ? undefined : `Install ${binary} or disable this optional integration.`);
  }
  return result;
}

export const REPORT_SCOPE = "Read-only local checks; no commands executed, credentials printed, or services contacted.";

export function reportOverview(findings: readonly Finding[]): { title: string; counts: string } {
  const warnings = findings.filter((row) => row.status === "warn").length;
  const passed = findings.filter((row) => row.status === "ok").length;
  const inactive = findings.filter((row) => row.status === "off").length;
  return {
    title: warnings ? `${warnings} item${warnings === 1 ? " needs" : "s need"} attention` : "local checks passed",
    counts: `${warnings} warning${warnings === 1 ? "" : "s"} · ${passed} check${passed === 1 ? "" : "s"} passed · ${inactive} inactive`,
  };
}

export function orderedFindings(findings: readonly Finding[]): Finding[] {
  const priority = { warn: 0, ok: 1, off: 2 };
  return [...findings].sort((a, b) => priority[a.status] - priority[b.status]);
}

export function formatReport(findings: readonly Finding[]): string {
  const overview = reportOverview(findings);
  return [`Doctor · ${overview.title}`, overview.counts, REPORT_SCOPE, "", ...orderedFindings(findings).flatMap((row) => [`${row.status === "ok" ? "✓" : row.status === "warn" ? "!" : "–"} ${row.label}: ${row.detail}`, ...(row.fix ? [`  Fix: ${row.fix}`] : [])])].join("\n");
}
