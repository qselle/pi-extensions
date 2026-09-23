import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "./checks.ts";

export type ConfigRead = { status: "absent" | "invalid" } | { status: "valid"; data: Record<string, unknown> };

/** Bounded, non-following JSON reads shared by the configuration diagnostics. */
export async function readConfig(agentDir: string, name: string): Promise<ConfigRead> {
  let file;
  try {
    const path = join(agentDir, name);
    const info = await lstat(path);
    if (!info.isFile() || info.size > 64 * 1024) return { status: "invalid" };
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const infoAfterOpen = await file.stat();
    if (!infoAfterOpen.isFile() || infoAfterOpen.size > 64 * 1024) return { status: "invalid" };
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 64 * 1024) return { status: "invalid" };
    const data = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? { status: "valid", data } : { status: "invalid" };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid" };
  } finally { await file?.close(); }
}

const resourceFields = ["extensions", "skills", "prompts", "themes"] as const;
const nonemptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonemptyString);
const isPattern = (value: string) => /^[!+-]/.test(value) || /[*?\[\]{}]/.test(value);

/** Only explicit local paths are probed: remote sources and ambiguous bare names are left to Pi. */
function localPath(value: string, baseDir: string): string | undefined {
  const path = value.trim();
  if (isPattern(path)) return undefined;
  if (path.startsWith("file://")) {
    try { return fileURLToPath(path); } catch { return undefined; }
  }
  if (path === "~") return homedir();
  if (path.startsWith("~/") || process.platform === "win32" && path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  // Pi additionally accepts MSYS/WSL/Cygwin drive paths; leave these shell aliases to its resolver.
  if (process.platform === "win32" && /^\/(?:mnt\/|cygdrive\/)?[a-z](?:\/|$)/i.test(path)) return undefined;
  if (isAbsolute(path) || path === "." || path === ".." || /^\.\.?[/\\]/.test(path)) return resolve(baseDir, path);
  return undefined;
}

/** Counts and known field names only; never return resource paths or source strings. */
export async function resourceFindings(data: Record<string, unknown>, agentDir: string): Promise<Finding[]> {
  const invalid: string[] = [];
  const entries = new Map<string, string[]>();
  for (const field of resourceFields) {
    if (data[field] === undefined) continue;
    if (!stringList(data[field])) invalid.push(field);
    else entries.set(field, data[field]);
  }
  if (data.packages !== undefined) {
    if (!Array.isArray(data.packages)) invalid.push("packages");
    else {
      const sources: string[] = [];
      data.packages.forEach((entry: unknown, index) => {
        if (nonemptyString(entry)) { sources.push(entry); return; }
        const field = `packages[${index}]`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) { invalid.push(field); return; }
        const config = entry as Record<string, unknown>;
        if (!nonemptyString(config.source)) invalid.push(`${field}.source`);
        else sources.push(config.source);
        if (config.autoload !== undefined && typeof config.autoload !== "boolean") invalid.push(`${field}.autoload`);
        for (const key of resourceFields) if (config[key] !== undefined && !stringList(config[key])) invalid.push(`${field}.${key}`);
      });
      entries.set("packages", sources);
    }
  }
  const duplicateCounts: string[] = [];
  const missingCounts: string[] = [];
  for (const [field, values] of entries) {
    const seen = new Set<string>();
    const paths = new Set<string>();
    let duplicates = 0;
    for (const value of values) {
      // Ordered include/exclude patterns may deliberately repeat; they are not duplicate loads.
      if (field !== "packages" && isPattern(value.trim())) continue;
      const path = localPath(value, agentDir);
      const identity = path ?? value.trim();
      if (seen.has(identity)) duplicates++;
      seen.add(identity);
      if (path) paths.add(path);
    }
    if (duplicates) duplicateCounts.push(`${field}: ${duplicates}`);
    let missing = 0;
    for (const path of paths) {
      try { await stat(path); }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) missing++; }
    }
    if (missing) missingCounts.push(`${field}: ${missing}`);
  }
  const findings: Finding[] = [{ id: "resource-settings", label: "Resource settings", status: invalid.length ? "warn" : "ok",
    detail: invalid.length ? `Malformed resource fields: ${invalid.slice(0, 8).join(", ")}${invalid.length > 8 ? ` and ${invalid.length - 8} more` : ""}.` : "Global package and resource lists have valid shapes; empty filters are allowed.",
    ...(invalid.length ? { fix: "Use arrays of nonempty paths/patterns; package objects need a source string, optional boolean autoload, and optional resource arrays. Review settings.json or use pi config." } : {}),
  }];
  if (duplicateCounts.length) findings.push({ id: "resource-duplicates", label: "Repeated resource entries", status: "warn",
    detail: `Repeated sources or plain paths in global settings (${duplicateCounts.join("; ")}). Pi may deduplicate these, so a repeated package filter can be ignored.`,
    fix: "Keep one entry per package source or resource path in settings.json; merge intended package filters with pi config." });
  if (missingCounts.length) findings.push({ id: "resource-missing", label: "Missing local resources", status: "warn",
    detail: `Explicit local paths in global settings do not exist (${missingCounts.join("; ")}). Remote sources, patterns, bare names and package filters are not checked.`,
    fix: "Restore or correct the local entries in settings.json, or remove stale entries with pi config, then /reload." });
  return findings;
}
