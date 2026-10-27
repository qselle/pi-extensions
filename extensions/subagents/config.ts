import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, type WaitBounds } from "./arguments.ts";
import { DEFAULT_MAX_OPEN_AGENTS } from "./coordinator.ts";

export interface SubagentsConfig {
  wait: WaitBounds;
  maxOpen: number;
}

export const DEFAULT_SUBAGENTS_CONFIG: SubagentsConfig = {
  wait: { minimumMs: 0, defaultMs: DEFAULT_WAIT_MS, maximumMs: MAX_WAIT_MS },
  maxOpen: DEFAULT_MAX_OPEN_AGENTS,
};

/** An invalid wait section falls back as a whole; a valid PI_SUBAGENT_MAX_OPEN wins over `maxOpen`. */
export function normalizeSubagentsConfig(value: unknown, env: Record<string, string | undefined> = process.env): SubagentsConfig {
  const source = value && typeof value === "object" ? value as Record<string, any> : {};
  const defaults = DEFAULT_SUBAGENTS_CONFIG.wait;
  const wait: WaitBounds = {
    minimumMs: integer(source.wait?.minimumMs, defaults.minimumMs),
    defaultMs: integer(source.wait?.defaultMs, defaults.defaultMs),
    maximumMs: integer(source.wait?.maximumMs, defaults.maximumMs),
  };
  const validWait = wait.minimumMs >= 0 && wait.minimumMs <= wait.defaultMs && wait.defaultMs <= wait.maximumMs && wait.maximumMs <= MAX_WAIT_MS;
  return {
    wait: validWait ? wait : { ...defaults },
    maxOpen: openLimit(env.PI_SUBAGENT_MAX_OPEN?.trim() ? Number(env.PI_SUBAGENT_MAX_OPEN) : undefined) ?? openLimit(source.maxOpen) ?? DEFAULT_MAX_OPEN_AGENTS,
  };
}

export function subagentsConfigPath(): string {
  return join(getAgentDir(), "subagents.json");
}

/** A missing or malformed file uses the defaults. */
export function loadSubagentsConfig(path = subagentsConfigPath(), env: Record<string, string | undefined> = process.env): SubagentsConfig {
  try {
    return normalizeSubagentsConfig(JSON.parse(readFileSync(path, "utf8")), env);
  } catch {
    return normalizeSubagentsConfig(undefined, env);
  }
}

function integer(value: unknown, fallback: number): number {
  return Number.isInteger(value) ? value as number : fallback;
}

function openLimit(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 16 ? value as number : undefined;
}
