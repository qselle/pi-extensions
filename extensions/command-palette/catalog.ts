import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { fuzzyMatch } from "../history-search/history.ts";

export interface PaletteCommand {
  name: string;
  description: string;
  source: "extension" | "prompt" | "skill";
  scope: string;
}

function cleanLabel(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
}

/** Keep Pi's invocation order for duplicate names; never invent a command. */
export function commandCatalog(commands: readonly SlashCommandInfo[]): PaletteCommand[] {
  const seen = new Set<string>();
  return commands.flatMap((command): PaletteCommand[] => {
    if (!command.name || command.name.length > 200 || /[\s\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(command.name)
      || command.name.startsWith("/") || seen.has(command.name)) return [];
    seen.add(command.name);
    return [{ name: command.name, description: cleanLabel(command.description ?? "").slice(0, 400),
      source: command.source, scope: cleanLabel(command.sourceInfo.scope) }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Word-order independent search across names, descriptions, kinds and scopes. */
export function searchCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const terms = query.trim().replace(/^\//, "").slice(0, 160).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...commands];
  return commands.flatMap((command) => {
    const name = command.name.toLocaleLowerCase();
    const detail = `${command.description} ${command.source} ${command.scope}`.toLocaleLowerCase();
    let score = 0;
    for (const term of terms) {
      const match = fuzzyMatch(name, term);
      if (name === term) score += 10_000;
      else if (name.startsWith(term)) score += 2_000;
      else if (name.includes(term)) score += 1_000;
      else if (detail.includes(term)) score += 100;
      else if (match) score += Math.max(1, Math.min(50, match.score));
      else return [];
    }
    return [{ command, score }];
  }).sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name)).map(({ command }) => command);
}
