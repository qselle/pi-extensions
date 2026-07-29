import { readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MAX_SEARCH_RESULTS,
  type MemoryScope,
} from "./types.ts";

export const DEFAULT_SEARCH_RESULTS = 8;
export const CONFIG_FILE = "memory.json";

export interface MemoryConfig {
  enabled: boolean;
  defaultScope: MemoryScope;
  confirmToolMutations: boolean;
  maxSearchResults: number;
}

export function defaultMemoryConfig(): MemoryConfig {
  return {
    enabled: false,
    defaultScope: "project",
    confirmToolMutations: true,
    maxSearchResults: DEFAULT_SEARCH_RESULTS,
  };
}

export function agentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function parseMemoryConfig(raw: unknown): MemoryConfig {
  const defaults = defaultMemoryConfig();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const input = raw as Record<string, unknown>;
  const requestedResults = typeof input.maxSearchResults === "number" && Number.isFinite(input.maxSearchResults)
    ? Math.floor(input.maxSearchResults)
    : defaults.maxSearchResults;
  return {
    enabled: input.enabled === true,
    defaultScope: input.defaultScope === "global" ? "global" : "project",
    confirmToolMutations: input.confirmToolMutations !== false,
    maxSearchResults: Math.min(MAX_SEARCH_RESULTS, Math.max(1, requestedResults)),
  };
}

export function loadMemoryConfig(directory = agentDirectory()): MemoryConfig {
  try {
    return parseMemoryConfig(JSON.parse(readFileSync(join(directory, CONFIG_FILE), "utf8")));
  } catch {
    return defaultMemoryConfig();
  }
}

/** Persist only the capability toggle while preserving every other config field. */
export async function setMemoryEnabled(enabled: boolean, directory = agentDirectory()): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, CONFIG_FILE);
  const existing = await readConfigObjectForMutation(path);
  const temporaryPath = join(directory, `.${CONFIG_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);

  try {
    await writeFile(temporaryPath, `${JSON.stringify({ ...existing, enabled }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }

  return path;
}

async function readConfigObjectForMutation(path: string): Promise<Record<string, unknown>> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Memory config is not a regular file: ${path}`);
    }
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Memory config must contain a JSON object: ${path}`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (isMissingFile(error)) return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Memory config is malformed; repair it instead of overwriting it: ${path}`);
    }
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
