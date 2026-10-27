import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export type RolloverReason = "manual" | "agent" | "automatic";
export interface BoundaryData { version: 1; reason?: RolloverReason; percent?: number; stale?: boolean }

export function boundaryLabel(data: Partial<BoundaryData> | undefined): string {
  const percent = typeof data?.percent === "number" && Number.isFinite(data.percent) ? ` at ${data.percent.toFixed(1)}%` : "";
  const cause = data?.reason === "manual" ? "manual" : data?.reason === "agent" ? "requested by agent" : data?.reason === "automatic" ? `automatic${percent}` : "";
  return ["Context reset", cause, data?.stale ? "stale notes" : "", "no summary"].filter(Boolean).join(" — ");
}

/** A dim centered rule; two spare columns keep styled full-width rows from wrapping. */
export function boundaryDivider(data: Partial<BoundaryData> | undefined, theme: Pick<Theme, "fg">): Component {
  const label = boundaryLabel(data);
  return {
    invalidate() {},
    render(width: number): string[] {
      const usable = Math.max(0, Math.floor(width) - 2);
      if (!usable) return [];
      const text = ` ${label} `;
      if (visibleWidth(text) + 2 > usable) return [theme.fg("dim", truncateToWidth(label, usable, "…"))];
      const fill = usable - visibleWidth(text);
      const left = Math.floor(fill / 2);
      return [theme.fg("dim", `${"─".repeat(left)}${text}${"─".repeat(fill - left)}`)];
    },
  };
}
