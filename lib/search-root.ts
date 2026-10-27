import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const BROAD_ROOT_NOTE = "Broad roots are rejected; choose a specific project or subdirectory.";

/** Broad macOS roots whose recursive scans can download iCloud or cloud-drive files. */
const MACOS_CLOUD_ROOTS = [
  ["Library"],
  ["Library", "Mobile Documents"],
  ["Library", "Mobile Documents", "com~apple~CloudDocs"],
  ["Library", "CloudStorage"],
] as const;

export interface SearchRootOptions {
  homeDir?: string;
  /** Defaults to macOS only. */
  cloudRoots?: boolean;
}

/**
 * Reject recursive searches rooted at home, its ancestors, or broad macOS
 * cloud roots. Specific descendants stay valid. The requested path is checked as
 * written, then after resolving symlinks, so an alias cannot bypass the check.
 */
export async function assertSearchRoot(tool: string, requested: unknown, cwd: string, options: SearchRootOptions = {}): Promise<void> {
  const home = resolve(options.homeDir ?? homedir());
  const root = resolveRoot(requested, cwd, home);
  const cloud = options.cloudRoots ?? process.platform === "darwin";
  if (isProtected(root, home, cloud)) throw broadRootError(tool, root);
  // Missing or unreadable paths are left for the tool to report.
  const real = await realpath(root).catch(() => undefined);
  if (real && isProtected(real, await realpath(home).catch(() => home), cloud)) throw broadRootError(tool, root);
}

function resolveRoot(requested: unknown, cwd: string, home: string): string {
  let value = typeof requested === "string" && requested ? requested : ".";
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(home, value.slice(2));
  return resolve(cwd, value);
}

function isProtected(root: string, home: string, cloud: boolean): boolean {
  const roots = [home, ...(cloud ? MACOS_CLOUD_ROOTS.map((segments) => resolve(home, ...segments)) : [])];
  return roots.some((target) => {
    const path = relative(root, target);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  });
}

function broadRootError(tool: string, root: string): Error {
  return new Error(`Refusing ${tool} search at broad root "${root}". Choose a specific project or subdirectory; home, its ancestors and macOS cloud-storage roots are blocked to prevent mass downloads.`);
}
