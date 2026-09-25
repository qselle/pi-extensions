import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { plainText } from "../../lib/transcript/model.ts";

export const REPORT_TOOL_NAME = "report_to_parent";
export const REPORT_MESSAGE_TYPE = "subagent-report";
export const MAX_REPORT_CHARS = 4_000;
export const MAX_RETAINED_REPORTS = 8;
export const MAX_SEEN_REPORT_IDS = 64;

export interface ParentReport { id: string; message: string; createdAt: number }
export interface SavedReport { report: ParentReport; runId: string; delivery: "none" | "automatic" | "wait" }

export function decodeParentReport(value: unknown): ParentReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const report = value as Partial<ParentReport>;
  if (typeof report.id !== "string" || !report.id || report.id.length > 500
    || typeof report.message !== "string" || !report.message.trim() || report.message.length > MAX_REPORT_CHARS
    || !Number.isFinite(report.createdAt) || report.createdAt! < 0) return undefined;
  const message = plainText(report.message).trim();
  if (!message) return undefined;
  return { id: report.id, message, createdAt: report.createdAt! };
}

export function registerChildReporter(pi: ExtensionAPI): void {
  pi.registerTool({
    name: REPORT_TOOL_NAME,
    label: "Report to parent",
    description: "Send a material interim finding that can unblock or redirect the parent. Use sparingly; ordinary commentary stays local and your final response is delivered automatically. This does not start a parent model turn.",
    parameters: Type.Object({ message: Type.String({ maxLength: MAX_REPORT_CHARS, description: "Concise actionable finding, evidence, or blocker for the parent." }) }),
    async execute(toolCallId, parameters, signal) {
      signal?.throwIfAborted();
      const message = typeof parameters.message === "string" ? parameters.message.trim() : "";
      if (!message || message.length > MAX_REPORT_CHARS) throw new Error(`Report message must contain 1–${MAX_REPORT_CHARS} characters.`);
      const report: ParentReport = { id: toolCallId, message, createdAt: Date.now() };
      return { content: [{ type: "text", text: "Interim report sent to the parent; continue your assigned work." }], details: { version: 1, report } };
    },
  });
}

export function renderParentReport(name: string, report: ParentReport, expanded: boolean, theme: Theme): Container {
  const container = new Container();
  const message = plainText(report.message);
  container.addChild(new Text(`${theme.fg("accent", "·")} ${theme.bold(plainText(name))} ${theme.fg("muted", "interim update")}`, 0, 0));
  container.addChild(expanded
    ? new Markdown(message, 0, 0, getMarkdownTheme())
    : new Text(theme.fg("dim", truncateToWidth(message.replace(/\s+/g, " "), 120, "…")), 0, 0));
  return container;
}
