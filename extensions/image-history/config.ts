import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE = "image-history.json";

/** Global defaults; a branch's own `/image-store` or `/image-history` choice always wins. */
export interface ImageHistoryConfig { storage: boolean; deferral: boolean }

export function loadConfig(agentDirectory: string): ImageHistoryConfig {
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(join(agentDirectory, CONFIG_FILE), "utf8")); } catch { parsed = undefined; }
  return { storage: parsed?.storage?.enabled !== false, deferral: parsed?.deferral?.enabled === true };
}

/** Original storage needs POSIX ownership; the global default stays quiet elsewhere. */
export const storageSupported = (): boolean => typeof process.getuid === "function";
