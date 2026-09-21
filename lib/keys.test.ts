import { expect, test } from "bun:test";
import { keyLabel } from "./keys.ts";

function manager(keys: Record<string, string[]>): never {
  return { getKeys: (id: string) => keys[id] ?? [] } as never;
}

test("labels the first bound key with pi's hint spelling", () => {
  const keybindings = manager({
    "tui.select.up": ["up"],
    "tui.select.down": ["down"],
    "tui.select.pageUp": ["pageUp"],
    "tui.select.cancel": ["escape", "ctrl+c"],
  });

  expect(keyLabel(keybindings, "tui.select.up", "?")).toBe("↑");
  expect(keyLabel(keybindings, "tui.select.down", "?")).toBe("↓");
  expect(keyLabel(keybindings, "tui.select.pageUp", "?")).toBe("PgUp");
  expect(keyLabel(keybindings, "tui.select.cancel", "?")).toBe("Esc");
});

test("reflects rebound keys instead of the default hint", () => {
  const keybindings = manager({
    "tui.select.cancel": ["ctrl+q"],
    "tui.select.confirm": ["ctrl+shift+m"],
  });

  expect(keyLabel(keybindings, "tui.select.cancel", "Esc")).toBe("Ctrl+Q");
  expect(keyLabel(keybindings, "tui.select.confirm", "Enter")).toBe("Ctrl+Shift+M");
});

test("falls back when a binding is unknown or the host predates getKeys", () => {
  expect(keyLabel(manager({}), "tui.select.confirm", "Enter")).toBe("Enter");
  expect(keyLabel({ matches: () => false } as never, "tui.select.cancel", "Esc")).toBe("Esc");
});
