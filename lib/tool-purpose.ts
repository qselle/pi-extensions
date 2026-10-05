import { Type } from "typebox";
import { PlainOutput } from "./output.ts";

/**
 * Keep display metadata optional: verbose or missing purpose text must not block
 * execution. Commands and file changes are asked to always carry one; reads and
 * searches may omit it when self-evident.
 */
export const commandPurposeParameter = Type.Optional(Type.String({
  description: "Brief user-facing purpose of this command: 3–8 words, at most 160 characters. Always include it, before command. Describe what it checks or changes; do not repeat the command or include private reasoning.",
}));

export const COMMAND_PURPOSE_GUIDELINE = "Include a brief purpose on every bash, edit and write call, explaining what it checks or changes (3–8 words). Keep it factual and user-facing; do not echo the command or path, or include private reasoning. Omit it only for self-evident reads and searches.";

export const changePurposeParameter = Type.Optional(Type.String({
  description: "Brief user-facing purpose: 3–8 words explaining what this change does. Always include it, first. Do not repeat paths or content. Never include secrets or private reasoning.",
}));

export const toolPurposeParameter = Type.Optional(Type.String({
  description: "Optional brief user-facing purpose: 3–8 words explaining what this action checks, finds or changes. Emit purpose first. Do not repeat paths, commands, queries or job IDs. Never include secrets or private reasoning. Omit it for self-evident reads and searches.",
}));

/** Some saved calls name their intent `reasoning`; a usable `purpose` wins. */
export function purposeArgument(args: unknown): unknown {
  if (args === null || typeof args !== "object") return undefined;
  const { purpose, reasoning } = args as Record<string, unknown>;
  return commandPurpose(purpose) ? purpose : reasoning;
}

/** Display metadata never reaches a tool's executor. Returns a copy. */
export function withoutPurpose<T extends Record<string, unknown>>(args: T): Omit<T, "purpose" | "reasoning"> {
  const { purpose: _purpose, reasoning: _reasoning, ...rest } = args;
  return rest;
}

/** Reuse the same display bounds; omit captions that merely repeat a target. */
export function toolPurpose(value: unknown, targets: readonly unknown[] = []): string {
  const purpose = commandPurpose(value);
  if (!purpose) return "";
  const comparable = purpose.toLocaleLowerCase();
  return targets.some((target) => typeof target === "string" && target.length <= 4096
    && commandPurpose(target).toLocaleLowerCase() === comparable) ? "" : purpose;
}

/** Plain, bounded display metadata; never use this text to construct a command. */
export function commandPurpose(value: unknown): string {
  if (typeof value !== "string") return "";
  let source = value.slice(0, 4096);
  // A display budget must not leave half of a supplementary-plane character.
  if (/[\uD800-\uDBFF]$/.test(source)) source = source.slice(0, -1);
  const clean = new PlainOutput().push(source).replace(/\p{Bidi_Control}/gu, "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const characters = Array.from(clean);
  return characters.length > 160 || source.length < value.length
    ? characters.slice(0, 159).join("").trimEnd() + "…"
    : clean;
}
