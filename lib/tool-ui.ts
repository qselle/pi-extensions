import type { Theme } from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { closeDanglingLink } from "./links.ts";

export const expansionHint = () => {
  const key = tui.getKeybindings?.().getKeys("app.tools.expand").join("/");
  return key ? `${key} to expand` : "Tool expansion is unbound";
};
export function fitToolRow(text: string, width: number): string {
  return closeDanglingLink(truncateToWidth(text, width, "…").replace(/\x1b\[0m/g, "\x1b[39m"));
}
export function toolText(text: string, wrap = false) {
  const component = wrap ? new Text(text, 0, 0) : undefined;
  return {
    invalidate() { component?.invalidate(); },
    render(width: number): string[] { return width <= 0 ? [] : (component?.render(width) ?? text.split("\n")).map(row => fitToolRow(row, width)); },
  };
}
export function toolHeadline(label: string, detail: string, theme: Theme, error = false) {
  return toolText(`${theme.fg(error ? "error" : "accent", "•")} ${theme.bold(label)}${detail ? ` ${theme.fg("text", detail)}` : ""}`, true);
}
