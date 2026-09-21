import type { KeybindingsManager } from "@earendil-works/pi-tui";

type KeybindingId = Parameters<KeybindingsManager["getKeys"]>[0];

const KEY_LABELS: Record<string, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  enter: "Enter",
  escape: "Esc",
  pageUp: "PgUp",
  pageDown: "PgDn",
};

/** Use the first binding to keep hints short; fall back when unbound. */
export function keyLabel(keybindings: KeybindingsManager, id: KeybindingId, fallback: string): string {
  const keys = typeof keybindings.getKeys === "function" ? keybindings.getKeys(id) : [];
  const [key] = keys;
  return key ? formatKey(key) : fallback;
}

function formatKey(key: string): string {
  return key.split("+").map(labelPart).join("+");
}

function labelPart(part: string): string {
  const known = KEY_LABELS[part];
  if (known) return known;
  // Matches pi's own hint formatting, which shows alt as option on macOS.
  const name = process.platform === "darwin" && part === "alt" ? "option" : part;
  return name.length > 1 ? name.charAt(0).toUpperCase() + name.slice(1) : name.toUpperCase();
}
