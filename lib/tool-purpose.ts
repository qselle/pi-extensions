import { Type } from "typebox";
import { PlainOutput } from "./output.ts";

/** Keep display metadata optional: verbose purpose text must not block execution. */
export const commandPurposeParameter = Type.Optional(Type.String({
  description: "Brief user-facing purpose of this command: 3–8 words, at most 160 characters. Emit purpose before command. Describe what it checks or changes; do not repeat the command or include private reasoning.",
}));

export const COMMAND_PURPOSE_GUIDELINE = "For bash calls, include a brief purpose explaining what the command checks or changes (3–8 words). Keep it factual and user-facing; do not echo the command or include private reasoning. Omit it when no useful explanation is needed.";

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
