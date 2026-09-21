import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifyCheck } from "./config.ts";

/** Estimate tokens at four characters each. */
export function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Single-quotes a path for POSIX shells; `cmd.exe` uses double quotes. */
export function shellQuote(value: string, platform: string = process.platform): string {
  if (platform === "win32") return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface TemplateValues {
  file: string;
  dir: string;
  files?: string[];
}

/** Shell-quote file placeholders before substituting them into the command. */
export function applyTemplate(
  command: string,
  values: TemplateValues,
  platform: string = process.platform,
): string {
  const files = values.files?.length ? values.files : [values.file];
  return command
    .replace(/\{file\}/g, shellQuote(values.file, platform))
    .replace(/\{dir\}/g, shellQuote(values.dir, platform))
    .replace(/\{files\}/g, files.map((file) => shellQuote(file, platform)).join(" "));
}

/** pi.exec spawns with shell:false, so a command string needs an explicit shell. */
export function shellInvocation(
  command: string,
  platform: string = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { command: string; args: string[] } {
  if (platform === "win32") return { command: "cmd.exe", args: ["/c", command] };
  return { command: env.SHELL || "/bin/sh", args: ["-c", command] };
}

export function combineOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
}

export interface BoundedOutput {
  text: string;
  truncated: boolean;
}

/** Head+tail truncation on line boundaries, used when spilling is unavailable. */
export function boundOutput(text: string, tokenLimit: number): BoundedOutput {
  if (tokenLimit <= 0 || approxTokenCount(text) <= tokenLimit) return { text, truncated: false };
  const charBudget = tokenLimit * 4;
  const lines = text.split("\n");
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > Math.floor(charBudget * 0.7)) break;
    head.push(line);
    used += line.length + 1;
  }
  for (let index = lines.length - 1; index > head.length; index -= 1) {
    const line = lines[index]!;
    if (used + line.length + 1 > charBudget) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  return { text: [...head, "[… output truncated …]", ...tail].join("\n"), truncated: true };
}

export interface SpillResult {
  /** Text safe to inject. */
  text: string;
  /** Set when the full output was written to disk. */
  path?: string;
  truncated: boolean;
}

export interface SpillOptions {
  tokenLimit: number;
  directory?: string;
  write?: (path: string, contents: string) => void;
}

/** Spill full output to disk; fall back to a truncated preview if the write fails. */
export function spillOutput(text: string, options: SpillOptions): SpillResult {
  const { tokenLimit } = options;
  if (tokenLimit <= 0 || approxTokenCount(text) <= tokenLimit) return { text, truncated: false };

  const preview = boundOutput(text, tokenLimit);
  const write = options.write ?? ((path: string, contents: string) => writeFileSync(path, contents, "utf8"));
  try {
    const directory = options.directory ?? mkdtempSync(join(tmpdir(), "pi-verify-"));
    const path = join(directory, "verify-output.txt");
    write(path, text);
    return { text: preview.text, path, truncated: true };
  } catch {
    return { text: preview.text, truncated: true };
  }
}

export interface FailureDetails {
  check: VerifyCheck;
  command: string;
  code: number | null;
  timedOut: boolean;
  output: string;
  spillPath?: string;
}

/** The edit succeeded; report check failures without inviting the agent to repeat it. */
export function formatFailure(details: FailureDetails): string {
  const { check, command, code, timedOut, output, spillPath } = details;
  const status = timedOut
    ? `timed out after ${Math.round(check.timeoutMs / 1000)}s`
    : `exit ${code ?? "unknown"}`;
  const lines = [
    "",
    `verify: ${check.name} failed (${status})`,
    `command: ${command}`,
    "The edit was applied. This check ran afterwards and failed, so fix the cause instead of repeating the edit.",
  ];
  if (output) lines.push("", output);
  if (spillPath) lines.push("", `Full output: ${spillPath}`);
  return lines.join("\n");
}
