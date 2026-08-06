import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 10 * 60_000;
/** Approximate token budget for injected output, matching Codex's hook default. */
export const DEFAULT_SPILL_TOKEN_LIMIT = 2_500;

export interface VerifyCheck {
  /** Glob(s) matched against the repo-relative path of the edited file. */
  match: string[];
  /** Shell command; supports {file}, {dir}, {files} placeholders. */
  command: string;
  name: string;
  timeoutMs: number;
}

export interface VerifyConfig {
  enabled: boolean;
  checks: VerifyCheck[];
  spillTokenLimit: number;
  /** Where the config came from, for /verify status. */
  source: "project" | "global" | "none";
  /** Populated when a project config existed but the project is untrusted. */
  untrustedProjectConfig?: boolean;
}

export function emptyConfig(): VerifyConfig {
  return { enabled: false, checks: [], spillTokenLimit: DEFAULT_SPILL_TOKEN_LIMIT, source: "none" };
}

export function agentDirectory(): string {
  return getAgentDir();
}

/**
 * Converts a glob to an anchored regex. Supports `**`, `*`, and `?` with POSIX
 * separators; everything else is matched literally.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*") {
      const isDouble = normalized[index + 1] === "*";
      if (isDouble) {
        const skipsSlash = normalized[index + 2] === "/";
        source += skipsSlash ? "(?:.*/)?" : ".*";
        index += skipsSlash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Repo-relative, POSIX-separated path used for matching. */
export function relativePosixPath(path: string, cwd: string): string {
  // Only absolute paths need resolving; a relative path is already repo-relative
  // and must not be re-resolved against process.cwd().
  const rel = isAbsolute(path) ? relative(cwd, path) : path;
  return (rel || path).split(sep).join("/").replace(/^\.\//, "");
}

export function matchCheck(config: VerifyConfig, relativePath: string): VerifyCheck | undefined {
  if (!config.enabled) return undefined;
  return config.checks.find((check) => check.match.some((pattern) => globToRegExp(pattern).test(relativePath)));
}

function parseCheck(raw: unknown, index: number): VerifyCheck | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!command) return undefined;

  const rawMatch = record.match;
  const match = (Array.isArray(rawMatch) ? rawMatch : [rawMatch])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  if (match.length === 0) return undefined;

  const rawTimeout = record.timeoutMs;
  const timeoutMs = typeof rawTimeout === "number" && rawTimeout > 0
    ? Math.min(rawTimeout, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  return {
    match,
    command,
    name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : `check ${index + 1}`,
    timeoutMs,
  };
}

export function parseConfig(raw: unknown, source: "project" | "global"): VerifyConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const checks = (Array.isArray(record.checks) ? record.checks : [])
    .map((value, index) => parseCheck(value, index))
    .filter((check): check is VerifyCheck => Boolean(check));
  if (checks.length === 0) return undefined;

  const rawLimit = record.spillTokenLimit;
  return {
    enabled: record.enabled !== false,
    checks,
    spillTokenLimit: typeof rawLimit === "number" && rawLimit > 0 ? Math.floor(rawLimit) : DEFAULT_SPILL_TOKEN_LIMIT,
    source,
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export interface LoadConfigOptions {
  cwd: string;
  /** Project config is executable, so it is only honored for trusted projects. */
  projectTrusted: boolean;
  agentDir?: string;
  readConfig?: (path: string) => unknown;
}

/**
 * Project config wins when present and trusted, otherwise the global config is
 * used. An untrusted project config is ignored and reported, never executed.
 */
export function loadConfig(options: LoadConfigOptions): VerifyConfig {
  const read = options.readConfig ?? readJson;
  const projectPath = join(options.cwd, CONFIG_DIR_NAME, "verify.json");
  const globalPath = join(options.agentDir ?? agentDirectory(), "verify.json");

  const projectRaw = read(projectPath);
  const projectPresent = projectRaw !== undefined;
  if (projectPresent && options.projectTrusted) {
    const parsed = parseConfig(projectRaw, "project");
    if (parsed) return parsed;
  }

  const globalParsed = parseConfig(read(globalPath), "global");
  const base = globalParsed ?? emptyConfig();
  return projectPresent && !options.projectTrusted ? { ...base, untrustedProjectConfig: true } : base;
}
