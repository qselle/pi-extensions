import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hyperlinkUrl } from "../../lib/links.ts";
import { cleanText, webUrl, type SearchHit, type SearchResult } from "./client.ts";
import { expansionHint, fitToolRow, toolText } from "../../lib/tool-ui.ts";

export { toolText as textBlock } from "../../lib/tool-ui.ts";

function sourceRow(hit: SearchHit, index: number, width: number, theme: Theme): string {
  const prefix = `[${index + 1}] `;
  const available = Math.max(0, width - visibleWidth(prefix));
  let url: string;
  try { url = webUrl(hit.url); }
  catch { return theme.fg("warning", `${prefix}Invalid source URL`); }
  const host = new URL(url).host;
  // Keep the actual origin visible. At tiny widths it takes priority over a title;
  // clipping a long hostname always carries an ellipsis, never an invented alias.
  const titleWidth = available - visibleWidth(host) - 3;
  const title = titleWidth >= 12 ? truncateToWidth(cleanText(hit.title, 240), titleWidth, "…") : "";
  const source = hyperlinkUrl(truncateToWidth(host, available, "…"), url);
  return theme.fg("accent", prefix) + (title ? `${title}${theme.fg("dim", " · ")}` : "") + theme.fg("muted", source);
}

function sourceRows(hit: SearchHit, index: number, width: number, theme: Theme): string[] {
  if (width < 36) return [sourceRow(hit, index, width, theme)];
  let url: string;
  try { url = webUrl(hit.url); } catch { return [theme.fg("warning", `[${index + 1}] Invalid source URL`)]; }
  const date = hit.published ? ` · ${cleanText(hit.published, 10)}${hit.dateUncertain ? "?" : ""}` : hit.dateUncertain ? " · date unknown" : "";
  const prefix = `[${index + 1}] `;
  const title = truncateToWidth(cleanText(hit.title, 240), Math.max(1, width - visibleWidth(prefix + date)), "…");
  return [theme.fg("accent", prefix) + theme.fg("text", title) + theme.fg("muted", date),
    "    " + theme.fg("muted", hyperlinkUrl(truncateToWidth(url, width - 4, "…"), url))];
}

export function searchPreview(details: SearchResult, theme: Theme) {
  const count = details.results.length;
  const metadata = [
    theme.fg("muted", `${details.provider} · ${count} source${count === 1 ? "" : "s"}`),
    ...(details.warning ? [theme.fg("warning", "Provider warning · expand for details")] : []),
    ...(details.provider === "mistral" ? [theme.fg("dim", "model-selected citations")] : []),
    ...(details.access || details.quality ? [theme.fg("muted", `${details.access ? `${details.access === "keyless" ? "keyless" : "account"} · ` : ""}${details.quality ? `${details.quality} · requested mode` : "search"}`)] : []),
    ...(details.dateRange ? [theme.fg("dim", `${details.dateRange.start ?? "any start"} → ${details.dateRange.end ?? "any end"} · requested`)] : []),
    ...(details.diagnostics && details.diagnostics.received > count ? [theme.fg("dim", `${details.diagnostics.received - count} rows excluded · expand for reasons`)] : []),
  ];
  return {
    invalidate() {},
    render(width: number): string[] {
      if (width <= 0) return [];
      const empty = details.diagnostics?.received ? "No usable sources remain · check filters"
        : details.warning ? "No sources returned · see warning"
        : details.provider === "mistral" ? "No web citations returned" : "No matches returned";
      const lines = [...metadata,
        ...details.results.slice(0, 3).flatMap((hit, index) => sourceRows(hit, index, width, theme)),
        ...(count > 3 ? [theme.fg("dim", `+${count - 3} more · expand to view`)] : []),
        ...(count === 0 ? [theme.fg("muted", empty)] : []),
        theme.fg("dim", expansionHint()),
      ];
      return lines.map((line) => fitToolRow(line, width));
    },
  };
}

/** Surface a bounded cause while leaving the complete tool error expandable. */
export function failurePreview(label: string, content: readonly { type: string; text?: string }[], theme: Theme) {
  const text = content.find((part) => part.type === "text" && part.text?.trim())?.text;
  const cause = cleanText(text, 1200);
  return toolText([theme.fg("error", `${label} failed`), ...(cause ? [theme.fg("muted", cause)] : []), theme.fg("dim", expansionHint())].join("\n"), true);
}
