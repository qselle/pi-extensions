export interface DateWindow { start?: string; end?: string }
interface PublicationBounds { start: number; end: number; partial: boolean }

/** Interpret calendar precision explicitly; never guess a locale for remote dates. */
export function publicationBounds(value: unknown): PublicationBounds | undefined {
  if (typeof value !== "string") return;
  const text = value.trim();
  const partial = /^([1-9]\d{3})(?:-(0[1-9]|1[0-2]))?$/.exec(text);
  if (partial) {
    const year = Number(partial[1]);
    const month = partial[2] ? Number(partial[2]) - 1 : 0;
    return { start: Date.UTC(year, month, 1), end: Date.UTC(year + (partial[2] ? 0 : 1), partial[2] ? month + 1 : 0, 1) - 1, partial: true };
  }
  if (!/^[1-9]\d{3}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(text)) return;
  const day = text.slice(0, 10);
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day) return;
  if (text.length === 10) return { start, end: start + 86_400_000 - 1, partial: false };
  const instant = Date.parse(text);
  if (Number.isFinite(instant)) return { start: instant, end: instant, partial: false };
}

export function publicationInWindow(value: unknown, window: DateWindow): "inside" | "outside" | "uncertain" {
  const bounds = publicationBounds(value);
  if (!bounds) return "uncertain";
  const start = window.start ? Date.parse(`${window.start}T00:00:00.000Z`) : -Infinity;
  const end = window.end ? Date.parse(`${window.end}T23:59:59.999Z`) : Infinity;
  if (bounds.end < start || bounds.start > end) return "outside";
  return bounds.start < start || bounds.end > end ? "uncertain" : "inside";
}
