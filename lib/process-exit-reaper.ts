const REGISTRY = Symbol.for("@qselle/pi-extensions.process-exit-reaper.v1");

type Reaper = () => void;
interface Registry { callbacks: Map<symbol, Reaper>; listener: () => void }

function createRegistry(): Registry {
  const callbacks = new Map<symbol, Reaper>();
  // Iterate a snapshot: reapers may unregister themselves, and one failing
  // cleanup must not stop the rest during Node's synchronous exit phase.
  const listener = () => { for (const reap of [...callbacks.values()]) { try { reap(); } catch { /* best effort */ } } };
  process.on("exit", listener);
  return { callbacks, listener };
}

// Extension modules are evaluated again on every reload. A global registry keeps
// one process listener for every module generation instead of one per reload.
const root = globalThis as typeof globalThis & { [REGISTRY]?: Registry };
const registry = (root[REGISTRY] ??= createRegistry());

/** Register synchronous cleanup for a hard process exit; returns an idempotent disposer. */
export function registerProcessExitReaper(callback: Reaper): () => void {
  const token = Symbol("process-exit-reaper");
  registry.callbacks.set(token, callback);
  return () => { registry.callbacks.delete(token); };
}
