import type { TranscriptBlock } from "../../lib/transcript/model.ts";
import { orderedFindings, reportOverview, REPORT_SCOPE, type Finding } from "./checks.ts";

export function reportBlocks(findings: readonly Finding[]): TranscriptBlock[] {
  const overview = reportOverview(findings);
  return [
    { id: "overview", kind: "custom", label: overview.title, labelColor: findings.some((row) => row.status === "warn") ? "warning" : "success", body: `${overview.counts}\n\n${REPORT_SCOPE}` },
    ...orderedFindings(findings).map((row): TranscriptBlock => ({
      id: `finding:${row.id}`, kind: "custom", label: `${row.status === "ok" ? "✓" : row.status === "warn" ? "!" : "–"} ${row.label}`,
      labelColor: row.status === "warn" ? "warning" : row.status === "ok" ? "success" : "muted",
      body: `${row.detail}${row.fix ? `\n\nFix: ${row.fix}` : ""}`,
    })),
  ];
}
