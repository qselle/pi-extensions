import type { TUI } from "@earendil-works/pi-tui";

export type FrameObserver = (frame: string[], columns: number, rows: number) => void;
type OverlayCompositor = (frame: string[], columns: number, rows: number) => string[];

interface FrameObserverHub {
  original: OverlayCompositor;
  patched: OverlayCompositor;
  observers: Map<symbol, FrameObserver>;
}

interface ObservableTui {
  compositeOverlays?: OverlayCompositor;
  [key: symbol]: unknown;
}

const FRAME_OBSERVER_KEY = Symbol.for("qselle.cat-buddy.frame-observer");

/**
 * Observe Pi's complete pre-overlay frame without owning input or adding layout
 * rows. The private compositor hook is shared across reloads and restored after
 * the final subscriber leaves. It fails closed if Pi changes the internal API.
 */
export function observeRenderedFrames(tui: TUI, observer: FrameObserver): (() => void) | undefined {
  const internal = tui as unknown as ObservableTui;
  let hub = internal[FRAME_OBSERVER_KEY] as FrameObserverHub | undefined;

  if (!hub) {
    if (typeof internal.compositeOverlays !== "function") return undefined;

    const original = internal.compositeOverlays;
    const observers = new Map<symbol, FrameObserver>();
    const patched: OverlayCompositor = (frame, columns, rows) => {
      for (const [id, inspect] of observers) {
        try {
          inspect(frame, columns, rows);
        } catch {
          observers.delete(id);
        }
      }
      return original.call(internal, frame, columns, rows);
    };

    hub = { original, patched, observers };
    internal[FRAME_OBSERVER_KEY] = hub;
    internal.compositeOverlays = patched;
  }

  const id = Symbol("cat-buddy-frame-observer");
  hub.observers.set(id, observer);
  const subscribedHub = hub;

  return () => {
    subscribedHub.observers.delete(id);
    if (subscribedHub.observers.size !== 0) return;
    if (internal.compositeOverlays !== subscribedHub.patched) return;

    internal.compositeOverlays = subscribedHub.original;
    if (internal[FRAME_OBSERVER_KEY] === subscribedHub) delete internal[FRAME_OBSERVER_KEY];
  };
}
