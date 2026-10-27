import { exaAccessSummary } from "../web-search/access.ts";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { parseAccent } from "../codex-prompt/config.ts";
import { supportsFastMode } from "../fast-mode/index.ts";
import { notificationEscape } from "../notify/deliver.ts";
import { readConfig, resourceFindings, type ConfigRead } from "./configuration.ts";
import { age, CACHE_FILE, CACHE_TTL_MS, parseCache, type ConnectorCache } from "../mistral-connectors/cache.ts";

export interface Finding { id: string; label: string; status: "ok" | "warn" | "off"; detail: string; fix?: string }
export interface DoctorInput {
  hostVersion?: string; modelAuthConfigured?: boolean; modelConfigInvalid?: boolean; bindingConflicts?: number;
  platform: NodeJS.Platform; bun: boolean; env: NodeJS.ProcessEnv; agentDir: string;
  tools: readonly string[]; activeTools: readonly string[]; commands: readonly string[];
  telegram: "enabled" | "disabled" | "invalid"; shell?: string;
  model?: { provider: string; api: string; id: string; baseUrl: string };
  now?: number;
  /** Resolves an exact enabledModels entry against Pi's model registry. */
  modelStatus?: (provider: string, id: string) => "ok" | "missing" | "unauthenticated";
  session?: { fileBytes?: number; entries: number };
}
export interface Probe {
  executable(name: string): Promise<boolean>;
  config(name: string): Promise<"absent" | "valid" | "invalid">;
  pty(): Promise<boolean>;
  resources?(): Promise<Finding[]>;
  connectorCache?(): Promise<ConnectorCache | "absent" | "invalid">;
  settings?(): Promise<Record<string, unknown> | undefined>;
}

const SESSION_WARN_BYTES = 25 * 1024 * 1024;
const SESSION_WARN_ENTRIES = 5_000;
/** `provider/model[:thinking]` without glob characters; patterns are left to Pi. */
const EXACT_MODEL = /^([\w.-]+)\/([^*?[\]{}\s]+?)(?::(?:off|minimal|low|medium|high|xhigh|max))?$/;

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Pi numbers extension commands registered under the same name: `name:1`, `name:2`. */
export function duplicateCommands(commands: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of commands) {
    const base = /^(.+):\d+$/.exec(name)?.[1];
    if (base && !name.startsWith("skill:")) counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return new Map([...counts].filter(([, count]) => count > 1));
}

/** Metadata checks only: no executable is launched and no network is contacted. */
export function localProbe(input: DoctorInput): Probe {
  const reads = new Map<string, Promise<ConfigRead>>();
  const read = (name: string) => {
    if (!reads.has(name)) reads.set(name, readConfig(input.agentDir, name));
    return reads.get(name)!;
  };
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
      // Settings are shared with resources() for a consistent diagnostic snapshot.
      const result = name === "settings.json" ? await read(name) : await readConfig(input.agentDir, name);
      if (result.status !== "valid") return result.status;
      const { data } = result;
      if (name === "settings.json") return "valid";
      if (name === "hyperlinks.json") return data.mode === undefined || ["auto", "always", "never"].includes(data.mode as string) ? "valid" : "invalid";
      if (name === "codex-prompt.json" && data.accent !== undefined && (typeof data.accent !== "string" || !parseAccent(data.accent))) return "invalid";
      const fields = name === "notify.json" ? ["enabled", "banner", "bell"] : ["enabled"];
      return fields.every((key) => data[key] === undefined || typeof data[key] === "boolean") ? "valid" : "invalid";
    },
    async resources() {
      const result = await read("settings.json");
      return result.status === "valid" ? resourceFindings(result.data, input.agentDir) : [];
    },
    async settings() {
      const result = await read("settings.json");
      return result.status === "valid" ? result.data : undefined;
    },
    async connectorCache() {
      // The connector list can exceed the 64 KiB settings cap.
      const result = await readConfig(input.agentDir, CACHE_FILE, 4 * 1024 * 1024);
      return result.status === "valid" ? parseCache(result.data) ?? "invalid" : result.status;
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
  if (input.hostVersion) {
    const supported = /^1\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(input.hostVersion);
    add("host-version", "Pi host", supported ? "ok" : "warn", `Version ${input.hostVersion}; supported line is 1.x (minimum 1.0.0).`, supported ? undefined : "Use the supported Pi host line and reload.");
  }
  if (input.modelConfigInvalid !== undefined) add("model-config", "Model configuration", input.modelConfigInvalid ? "warn" : "ok", input.modelConfigInvalid ? "Pi reports a model configuration error; raw configuration is not displayed." : "Pi's model registry reports no configuration error.", input.modelConfigInvalid ? "Repair models.json, then reload Pi." : undefined);
  if (input.modelAuthConfigured !== undefined) add("model-auth", "Current model authentication", input.modelAuthConfigured ? "ok" : "warn", input.modelAuthConfigured ? "Authentication is configured according to Pi metadata; validity and balance are not tested." : "Pi reports no configured authentication for the selected model.", input.modelAuthConfigured ? undefined : "Use /login or configure the provider, then select the model again.");
  if (input.bindingConflicts !== undefined) add("keybindings", "Custom key assignments", input.bindingConflicts ? "warn" : "ok", input.bindingConflicts ? `${input.bindingConflicts} duplicate custom key assignment(s) reported by Pi; some may be intentional in separate UI contexts.` : "Pi reports no duplicate custom key assignments.", input.bindingConflicts ? "Review keybindings.json and keep intended context-specific overlaps." : undefined);
  const hostSettings = await probe.config("settings.json");
  add("host-settings", "Host settings", hostSettings === "invalid" ? "warn" : "ok", hostSettings === "invalid" ? "Global settings JSON is unreadable, oversized or malformed." : hostSettings === "absent" ? "No global settings file; defaults apply." : "Global settings JSON is readable; values and project overrides are not exhaustively validated.", hostSettings === "invalid" ? "Repair settings.json in the Pi agent directory." : undefined);
  if (probe.resources) result.push(...await probe.resources());
  const duplicates = duplicateCommands(input.commands);
  add("duplicate-commands", "Extension commands", duplicates.size ? "warn" : "ok", duplicates.size ? `Registered more than once: ${[...duplicates].map(([name, count]) => `/${name} (${count})`).join(", ")}. Pi numbers them, for example /${duplicates.keys().next().value}:1.` : "No extension command name is registered twice. Shortcut conflicts are reported by Pi at startup.", duplicates.size ? "Disable one of the packages or extensions that register the command, then /reload." : undefined);
  const enabled = input.modelStatus && probe.settings ? (await probe.settings())?.enabledModels : undefined;
  if (input.modelStatus && Array.isArray(enabled)) {
    const exact = enabled.filter((spec): spec is string => typeof spec === "string").map((spec) => [spec, EXACT_MODEL.exec(spec.trim())] as const).filter(([, match]) => match);
    const problems = exact.map(([spec, match]) => [spec, input.modelStatus!(match![1]!, match![2]!)] as const).filter(([, status]) => status !== "ok");
    const missing = problems.filter(([, status]) => status === "missing").map(([spec]) => spec);
    const unauthenticated = problems.filter(([, status]) => status === "unauthenticated").map(([spec]) => spec);
    const list = (specs: string[]) => `${specs.slice(0, 5).join(", ")}${specs.length > 5 ? ` and ${specs.length - 5} more` : ""}`;
    add("enabled-models", "Enabled models", problems.length ? "warn" : "ok", problems.length
      ? [missing.length ? `Not found: ${list(missing)}.` : "", unauthenticated.length ? `No configured authentication: ${list(unauthenticated)}.` : ""].filter(Boolean).join(" ")
      : `${exact.length} exact enabledModels entr${exact.length === 1 ? "y resolves" : "ies resolve"} to authenticated models; patterns are left to Pi.`,
    problems.length ? "Correct stale enabledModels entries in settings.json, or /login the provider." : undefined);
  }
  if (input.session) {
    const { fileBytes, entries } = input.session;
    const large = (fileBytes ?? 0) > SESSION_WARN_BYTES || entries > SESSION_WARN_ENTRIES;
    add("session-size", "Current session", large ? "warn" : "ok", `${fileBytes === undefined ? "Not saved to a file" : `Session file ${formatBytes(fileBytes)}`}, ${entries.toLocaleString("en-US")} entries.${large ? " Large sessions load, branch and search more slowly." : ""}`, large ? "Continue in a fresh session (for example with /new) and keep this one for reference." : undefined);
  }
  const shellFound = !!input.shell && await probe.executable(input.shell);
  add("shell", "Shell", shellFound ? "ok" : "warn", shellFound ? "Pi resolved an available shell executable." : "Pi could not resolve an available shell executable.", shellFound ? undefined : "Install bash and make it available to Pi, then restart.");
  for (const [name, label] of [["web_search", "Web search"], ["web_read", "Page reader"], ["job_start", "Managed jobs"]]) {
    const status = !loaded(name!) ? "off" : active(name!) || name === "job_start" && active("bash") ? "ok" : "warn";
    add(`tool-${name}`, label!, status, status === "off" ? "Extension tool is not loaded." : status === "warn" ? "Tool is loaded but inactive for this agent." : name === "job_start" ? "Managed bash is active; job controls activate when needed." : "Tool is loaded and active.", status === "warn" ? "Enable this tool in your active tool selection." : undefined);
  }
  const providers = [input.env.EXA_API_KEY?.trim() ? "Exa" : "", input.env.FIRECRAWL_API_KEY?.trim() ? "Firecrawl (explicit provider selection)" : "", input.env.MISTRAL_API_KEY?.trim() ? "Mistral (explicit provider selection)" : ""].filter(Boolean);
  if (loaded("web_search")) {
    add("search-keys", "Search access", "ok", `Default: Exa ${exaAccessSummary(input.env)}${input.env.EXA_API_KEY?.trim() ? "" : "; no API key required"}. Connectivity and rate limits are not tested.${providers.length ? ` ${providers.join(" and ")} credentials present; validity not tested.` : ""}`);
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
  if (input.commands.includes("mistral-connectors") && probe.connectorCache) {
    const cache = await probe.connectorCache();
    if (cache === "absent" || cache === "invalid") add("mistral-connectors", "Mistral connectors", "warn", cache === "absent" ? "No connector list is cached, so no connector servers are registered." : "The connector cache is unreadable or has an unknown format.", "Run /mistral-connectors refresh with a Mistral API key configured.");
    else {
      const fetched = age(Math.max(0, (input.now ?? Date.now()) - cache.fetchedAt));
      const ready = cache.connectors.filter((connector) => connector.ready).length;
      // Only the status or a known cause is shown; remote error bodies stay out of the report.
      const cause = cache.lastError ? cache.lastError.match(/HTTP \d{3}/)?.[0] ?? (/No API key/.test(cache.lastError) ? "no Mistral API key" : "request failed") : undefined;
      const stale = (input.now ?? Date.now()) - cache.fetchedAt > 24 * 60 * 60 * 1000;
      add("mistral-connectors", "Mistral connectors", cause || stale ? "warn" : "ok", `${ready} ready connector${ready === 1 ? "" : "s"}; list fetched ${fetched}${cause ? `; last refresh failed (${cause})` : ""}. Refreshes run at session start when older than ${CACHE_TTL_MS / 60_000} minutes.`, cause || stale ? "Run /mistral-connectors status for details, then /mistral-connectors refresh." : undefined);
    }
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
