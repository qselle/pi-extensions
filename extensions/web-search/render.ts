import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { hyperlinkUrl } from "../../lib/links.ts";
import { cleanText, webUrl, type SearchHit, type SearchResult } from "./client.ts";
import { freshnessLabel } from "./filters.ts";
import { expansionHint, fitToolRow } from "../../lib/tool-ui.ts";

export { toolText as textBlock } from "../../lib/tool-ui.ts";

const PREVIEW_SOURCES = 3;
const providerNames = { exa: "Exa", firecrawl: "Firecrawl", mistral: "Mistral" };

function wrapped(text: string, width: number, prefix = "    "): string[] {
  if (width <= visibleWidth(prefix)) return [fitToolRow(prefix + text, width)];
  return wrapTextWithAnsi(text, width - visibleWidth(prefix)).map((line) => prefix + line);
}

function sourceRows(hit: SearchHit, index: number, width: number, theme: Theme, expanded: boolean): string[] {
  const prefix = `    ${index + 1}. `;
  const indent = " ".repeat(visibleWidth(prefix));
  let url: string;
  try { url = webUrl(hit.url); }
  catch { return [theme.fg("warning", `${prefix}Invalid source URL`)]; }
  const host = new URL(url).host;
  const title = cleanText(hit.title, 240);
  const available = Math.max(0, width - visibleWidth(prefix));
  const link = (label: string) => hyperlinkUrl(truncateToWidth(label, available, "…"), url);
  let titleIsUrl = false;
  try { titleIsUrl = webUrl(cleanText(hit.title, 4096)) === url; } catch { /* descriptive title */ }
  if (!expanded) {
    // Keep the full origin visible before spending space on a descriptive title.
    // Both labels point at the source, including terminals with no mouse support.
    const titleWidth = available - visibleWidth(host) - 3;
    if (!title || titleIsUrl || title === host || titleWidth < 12) {
      return [theme.fg("dim", prefix) + theme.fg("muted", link(host))];
    }
    const subject = hyperlinkUrl(truncateToWidth(title, titleWidth, "…"), url);
    return [theme.fg("dim", prefix) + theme.fg("text", subject) + theme.fg("dim", " · ") + theme.fg("muted", hyperlinkUrl(host, url))];
  }
  const urlRows = () => available > 0
    ? wrapTextWithAnsi(url, available).map((line) => indent + theme.fg("muted", hyperlinkUrl(line, url)))
    : [indent + theme.fg("muted", link(url))];
  const lines: string[] = [];
  if (titleIsUrl || !title || title === host) {
    const urls = urlRows();
    lines.push(theme.fg("dim", prefix) + urls[0]!.slice(indent.length), ...urls.slice(1));
  } else {
    const titles = wrapped(theme.fg("text", title), width, indent);
    lines.push(theme.fg("dim", prefix) + titles[0]!.slice(indent.length), ...titles.slice(1));
    lines.push(...urlRows());
  }
  if (expanded) {
    const date = hit.published ? `Published ${cleanText(hit.published, 40)}${hit.dateUncertain ? " · date range unverified" : ""}` : hit.dateUncertain ? "Publication date unknown · date range unverified" : "";
    if (date) lines.push(...wrapped(theme.fg("dim", date), width, indent));
    const snippet = cleanText(hit.snippet);
    if (snippet) lines.push(...wrapped(theme.fg("muted", snippet), width, indent));
  }
  return lines;
}

function summary(details: SearchResult): string {
  const count = details.results.length;
  const ms = details.elapsedMs;
  const elapsed = ms !== undefined && Number.isFinite(ms) && ms >= 0 ? (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`) : undefined;
  return [
    `${count} source${count === 1 ? "" : "s"}`, providerNames[details.provider],
    details.access === "keyless" ? "public" : details.access === "api-key" ? "API" : undefined,
    details.attempts?.length ? `${details.attempts.length} attempts` : undefined,
    details.quality && details.quality !== "balanced" ? details.quality : undefined, elapsed,
  ].filter(Boolean).join(" · ");
}

function compactFilters(details: SearchResult): string {
  return [
    details.category, details.domains?.length ? details.domains.join(", ") : undefined,
    details.excludedDomains?.length ? `exclude ${details.excludedDomains.join(", ")}` : undefined,
    details.dateRange ? `${details.dateRange.start ?? "any start"} → ${details.dateRange.end ?? "any end"}` : undefined,
    details.maxAgeHours !== undefined ? freshnessLabel(details.maxAgeHours) : undefined,
  ].filter(Boolean).join(" · ");
}

/** Human display stays separate from the complete, source-numbered model output. */
export function searchPreview(details: SearchResult, theme: Theme, expanded = false) {
  return {
    invalidate() {},
    render(width: number): string[] {
      if (width <= 0) return [];
      const count = details.results.length;
      const lines = wrapped(theme.fg("muted", summary(details)), width);
      lines[0] = theme.fg("dim", "  └ ") + lines[0]!.slice(4);
      const filters = compactFilters(details);
      if (filters) lines.push(...wrapped(theme.fg("dim", cleanText(filters, 1200)), width));
      if (details.provider === "mistral") lines.push(...wrapped(theme.fg("dim", "model-selected citations"), width));
      if (details.warning) lines.push(...wrapped(theme.fg("warning", expanded ? `Provider warning: ${cleanText(details.warning, 500)}` : "Provider warning · expand for details"), width));
      const visible = expanded ? details.results : details.results.slice(0, PREVIEW_SOURCES);
      visible.forEach((hit, index) => {
        if (expanded) lines.push("");
        lines.push(...sourceRows(hit, index, width, theme, expanded));
      });
      if (!count) {
        const empty = details.diagnostics?.received ? "No usable sources remain · check filters"
          : details.warning ? "No sources returned · see warning"
          : details.provider === "mistral" ? "No web citations returned" : "No matches returned · try a broader query";
        lines.push(...wrapped(theme.fg("muted", empty), width));
      }
      const stats = details.diagnostics;
      const excluded = stats ? stats.received - count : 0;
      if (expanded) {
        if (details.attempts?.length) lines.push(...wrapped(theme.fg("dim", `Route: ${details.attempts.map((attempt) => `${attempt.provider} ${attempt.outcome}${attempt.reason ? ` (${cleanText(attempt.reason, 80)})` : ""}`).join(" → ")}`), width));
        const diagnostics = stats ? [
          stats.invalid ? `${stats.invalid} invalid` : "", stats.duplicate ? `${stats.duplicate} duplicate` : "",
          stats.outsideDomains ? `${stats.outsideDomains} outside requested domains` : "",
          stats.excludedDomains ? `${stats.excludedDomains} excluded domains` : "",
          stats.outsideDates ? `${stats.outsideDates} outside requested dates` : "",
          stats.omitted ? `${stats.omitted} beyond result limit` : "",
        ].filter(Boolean) : [];
        if (diagnostics.length) lines.push(...wrapped(theme.fg("dim", `Filtered: ${diagnostics.join(" · ")}`), width));
        if (stats?.uncertainDates) lines.push(...wrapped(theme.fg("dim", `${stats.uncertainDates} source(s) with unverified publication dates`), width));
        if (details.maxAgeHours !== undefined) lines.push(...wrapped(theme.fg("dim", "Content freshness requested, not independently verified"), width));
      } else {
        const footer = [count > PREVIEW_SOURCES ? `+${count - PREVIEW_SOURCES} more` : "", excluded > 0 ? `${excluded} rows excluded` : "", expansionHint()].filter(Boolean).join(" · ");
        lines.push(...wrapped(theme.fg("dim", footer), width));
      }
      return lines.map((line) => fitToolRow(line, width));
    },
  };
}

/** Surface a bounded cause while leaving the complete tool error expandable. */
export function failurePreview(label: string, content: readonly { type: string; text?: string }[], theme: Theme) {
  const text = content.find((part) => part.type === "text" && part.text?.trim())?.text;
  const cause = cleanText(text, 1200);
  return {
    invalidate() {},
    render(width: number): string[] {
      if (width <= 0) return [];
      const lines = wrapped(theme.fg("error", cause || `${label} failed`), width);
      lines[0] = theme.fg("dim", "  └ ") + lines[0]!.slice(4);
      lines.push(...wrapped(theme.fg("dim", expansionHint()), width));
      return lines.map((line) => fitToolRow(line, width));
    },
  };
}
