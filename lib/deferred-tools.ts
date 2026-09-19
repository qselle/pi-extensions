import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Hide idle controls, then restore only the tools this instance deferred. */
export function deferredTools(pi: ExtensionAPI, names: readonly string[]) {
  let withheld = new Set<string>();
  return {
    initialize(relevant = false) {
      if (!pi.getActiveTools || !pi.setActiveTools) return;
      const active = pi.getActiveTools();
      withheld = new Set(relevant ? [] : active.filter(name => names.includes(name)));
      if (withheld.size) pi.setActiveTools(active.filter(name => !withheld.has(name)));
    },
    activate(selected: readonly string[] = names) {
      if (!withheld.size) return;
      const add = selected.filter(name => withheld.has(name));
      if (!add.length) return;
      const active = pi.getActiveTools();
      pi.setActiveTools([...new Set([...active, ...add])]);
      // Subsequent updates must not re-enable a tool the user manually disabled.
      for (const name of add) withheld.delete(name);
    },
  };
}
