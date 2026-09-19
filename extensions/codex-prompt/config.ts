import { readFileSync, statSync, writeFileSync } from "node:fs";
export type EditorAccent = "theme" | "thinking" | string;
export interface PromptSettings { enabled: boolean; accent: EditorAccent }
export function parseAccent(value: string): EditorAccent | undefined {
  const color = value.trim().toLowerCase();
  return color === "theme" || color === "thinking" || /^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/.test(color) ? color : undefined;
}
function readObject(path: string): Record<string, unknown> {
  try {
    const stat = statSync(path);
    if (stat.size > 64000 || !stat.isFile()) throw new Error("Settings file must be a small JSON object.");
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Settings file must contain a JSON object.");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Cannot read prompt settings. Repair codex-prompt.json before changing settings.");
  }
}
export function readSettings(path: string): PromptSettings {
  try {
    const value = readObject(path);
    return { enabled: value.enabled !== false, accent: typeof value.accent === "string" ? parseAccent(value.accent) ?? "theme" : "theme" };
  } catch { return { enabled: true, accent: "theme" }; }
}
export function writeSettings(path: string, update: Partial<PromptSettings>): void {
  writeFileSync(path, `${JSON.stringify({ ...readObject(path), ...update }, null, 2)}\n`);
}
export function accentColor(accent: EditorAccent, theme: (text: string) => string): ((text: string) => string) | undefined {
  if (accent === "thinking") return undefined;
  if (accent === "theme" || !/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/.test(accent)) return theme;
  const hex = accent.length === 4 ? [...accent.slice(1)].map((char) => char + char).join("") : accent.slice(1);
  const rgb = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return (text) => `\x1b[38;2;${rgb.join(";")}m${text}\x1b[39m`;
}
