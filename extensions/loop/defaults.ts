import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MAX_LOOP_PROMPT_CHARS } from "./loop.ts";

export const BUILTIN_LOOP_PROMPT = [
  "Continue any unfinished work already authorized in this conversation.",
  "Then tend to the current branch or pull request: inspect new review feedback, failing CI, and merge conflicts, and make bounded progress where authority already exists.",
  "If nothing is pending, perform a narrow maintenance pass for bugs, unnecessary complexity, or missing verification in the work already in scope.",
  "Do not start unrelated initiatives. A scheduled wakeup never grants new authority to push, deploy, delete, publish, or contact external systems.",
  "When there is no useful work left, call loop_stop.",
].join("\n\n");

export interface DefaultLoopPrompt {
  prompt: string;
  source: "builtin" | "project" | "user";
  path?: string;
}

export function loadDefaultLoopPrompt(cwd: string, agentDir = getAgentDir(), projectTrusted = true): DefaultLoopPrompt {
  const candidates = [
    ...(projectTrusted ? [{ path: join(cwd, ".pi", "loop.md"), source: "project" as const }] : []),
    { path: join(agentDir, "loop.md"), source: "user" as const },
  ];

  for (const candidate of candidates) {
    const prompt = readSafePrompt(candidate.path);
    if (prompt) return { prompt, source: candidate.source, path: candidate.path };
  }
  return { prompt: BUILTIN_LOOP_PROMPT, source: "builtin" };
}

function readSafePrompt(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LOOP_PROMPT_CHARS * 4) return undefined;
    const prompt = readFileSync(path, "utf8").trim();
    if (!prompt || prompt.length > MAX_LOOP_PROMPT_CHARS) return undefined;
    return prompt;
  } catch {
    return undefined;
  }
}
