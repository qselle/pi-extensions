/** State is independent of the host and clock, including concurrent tool calls. */
export class WorkingState {
  startedAt: number | undefined;
  phase = "Waiting for model";
  readonly tools = new Map<string, string>();

  start(now: number): void {
    this.reset();
    this.startedAt = now;
  }

  reset(): void {
    this.startedAt = undefined;
    this.phase = "Waiting for model";
    this.tools.clear();
  }

  label(now: number): string | undefined {
    if (this.startedAt === undefined) return undefined;
    const names = [...new Set(this.tools.values())];
    const phase = names.length ? `Running ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}` : this.phase;
    return `${phase} · ${elapsed(now - this.startedAt)}`;
  }
}

export function elapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function toolLabel(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 28) || "tool";
}
