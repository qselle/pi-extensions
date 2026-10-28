import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Additive activation for idle controls. Register each control with `defaultActive: false`; Pi
 * then keeps it inactive until first use, and resumed branches keep the controls they activated.
 */
export function deferredTools(pi: ExtensionAPI, names: readonly string[]) {
  let pending = new Set<string>();
  return {
    /** Call on session start and tree navigation; controls already active belong to the user. */
    initialize() {
      if (!pi.getActiveTools || !pi.setActiveTools) return;
      const active = new Set(pi.getActiveTools());
      pending = new Set(names.filter(name => !active.has(name)));
    },
    activate(selected: readonly string[] = names) {
      const add = selected.filter(name => pending.has(name));
      if (!add.length) return;
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...add])]);
      // Subsequent updates must not re-enable a tool the user manually disabled.
      for (const name of add) pending.delete(name);
    },
  };
}
