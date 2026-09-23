import { PlainOutput } from "../../lib/output.ts";

/** State is independent of the host and clock, including concurrent tool calls. */
export class WorkingState {
  startedAt: number | undefined;
  phase = "Waiting for model";
  readonly tools = new Map<string, string>();

  start(now: number): void {
    this.reset();
    this.startedAt = now;
  }

  reset(): void {
    this.startedAt = undefined;
    this.phase = "Waiting for model";
    this.tools.clear();
  }

  label(now: number): string | undefined {
    if (this.startedAt === undefined) return undefined;
    const counts = new Map<string, number>();
    for (const name of this.tools.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
    const names = [...counts];
    const shown = names.slice(0, 2).map(([name, count]) => count > 1 ? `${name} ×${count}` : name);
    const remaining = names.slice(2).reduce((sum, [, count]) => sum + count, 0);
    const phase = names.length ? `Running ${shown.join(", ")}${remaining ? ` +${remaining}` : ""}` : this.phase;
    return `${phase} · ${elapsed(now - this.startedAt)}`;
  }
}

export function elapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function toolLabel(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 28) || "tool";
}

// Reveal only the executable family, never arguments, environment assignments,
// URLs, query text, or shell output (all of which may contain credentials).
const KNOWN_COMMANDS = new Set([
  "bun", "npm", "npx", "pnpm", "yarn", "node", "deno", "python", "python3", "pip", "uv",
  "git", "gh", "rg", "grep", "find", "ls", "cat", "sed", "awk", "pwd", "cd",
  "cargo", "rustc", "go", "make", "cmake", "docker", "podman", "curl", "wget", "ssh",
  "pytest", "vitest", "jest", "tsc", "swift", "swiftc", "dotnet", "java", "mvn", "gradle",
]);

export function toolActivity(name: string, args: unknown): string {
  const label = toolLabel(name);
  if (!args || typeof args !== "object") return label;
  const input = args as Record<string, unknown>;
  if (["read", "edit", "write"].includes(name) && typeof input.path === "string") {
    const path = new PlainOutput().push(input.path.slice(0, 4096)).replace(/\s+/g, " ").trim();
    const target = path.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
    const characters = [...target];
    const short = characters.length > 32 ? `…${characters.slice(-31).join("")}` : target;
    return short ? `${label} ${short}` : label;
  }
  if (name === "bash" && typeof input.command === "string") {
    const executable = /^\s*([a-zA-Z][a-zA-Z0-9.-]*)(?:\s|$)/.exec(input.command)?.[1];
    if (executable && KNOWN_COMMANDS.has(executable)) return `${label}: ${executable}`;
  }
  return label;
}
