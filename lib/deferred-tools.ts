import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Additive activation for idle controls. With `registeredInactive`, each control is registered
 * with `defaultActive: false`: Pi keeps it inactive until first use, and resumed branches keep the
 * controls they activated. Otherwise controls registered active are withheld at session start,
 * which removes restored controls on resume; that legacy path remains for unmigrated callers.
 */
export function deferredTools(pi: ExtensionAPI, names: readonly string[], { registeredInactive = false } = {}) {
  let pending = new Set<string>();
  return {
    /** Call on session start and tree navigation. */
    initialize() {
      if (!pi.getActiveTools || !pi.setActiveTools) return;
      const active = pi.getActiveTools();
      if (registeredInactive) {
        // Controls already active belong to the user.
        pending = new Set(names.filter(name => !active.includes(name)));
        return;
      }
      // Tree navigation may keep controls already withheld; own them until activated.
      pending = new Set([...pending, ...active.filter(name => names.includes(name))]);
      if (pending.size) pi.setActiveTools(active.filter(name => !pending.has(name)));
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
