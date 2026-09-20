import type { WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";

export const WORKING_STYLES = ["native", "pulse", "static", "text"] as const;
export type WorkingStyle = typeof WORKING_STYLES[number];
export const STYLE_ENTRY = "working-status-style";

export function isWorkingStyle(value: unknown): value is WorkingStyle {
  return typeof value === "string" && (WORKING_STYLES as readonly string[]).includes(value);
}

export function indicatorStyle(style: WorkingStyle): WorkingIndicatorOptions | undefined {
  if (style === "native") return undefined;
  if (style === "text") return { frames: [] };
  if (style === "static") return { frames: ["●"] };
  return { frames: ["·", "•", "●", "•"], intervalMs: 240 };
}
