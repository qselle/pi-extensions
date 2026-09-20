import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { buildReport, formatReport } from "./report.ts";

export function parseExportCommand(args: string): { scope: "branch" | "session"; format: "json" | "csv"; path?: string } | undefined {
  const match = /^(branch|session)\s+(json|csv)(?:\s+(.+))?$/s.exec(args.trim());
  if (!match) return undefined;
  let path = match[3]?.trim();
  if (path && ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'")))) path = path.slice(1, -1);
  if (path && /[\x00-\x1f\x7f]/.test(path)) return undefined;
  return { scope: match[1] as "branch" | "session", format: match[2] as "json" | "csv", path: path || undefined };
}
export default function usageExport(pi: ExtensionAPI): void {
  pi.registerCommand("usage-export", {
    description: "Export local usage: /usage-export branch|session json|csv <new file>",
    handler: async (args, ctx) => {
      const command = parseExportCommand(args);
      if (!command) {
        ctx.ui.notify("Usage: /usage-export branch|session json|csv [new file]. Omit the file for a usage summary.", "info");
        return;
      }
      const entries = command.scope === "branch" ? ctx.sessionManager.getBranch() : ctx.sessionManager.getEntries();
      const report = buildReport(entries, command.scope);
      const cost = report.totals.cost;
      const tokens = (key: "input" | "output") => `${report.totals[key].known} ${key}${report.totals[key].missing ? ` (${report.totals[key].missing} unknown)` : ""}`;
      const summary = `${report.rows.length} usage records · ${tokens("input")} · ${tokens("output")} · recorded cost $${cost.known.toFixed(4)}${cost.missing ? ` (${cost.missing} records missing cost)` : ""}`;
      if (!command.path) { ctx.ui.notify(summary, "info"); return; }
      const requested = command.path.startsWith("~/") ? resolve(homedir(), command.path.slice(2)) : resolve(ctx.cwd, command.path);
      try {
        // Exclusive creation also refuses existing symlinks. Files contain no
        // prompts, responses, tool arguments, workspace paths or credentials.
        await writeFile(requested, formatReport(report, command.format), { flag: "wx", mode: 0o600 });
        ctx.ui.notify(`Exported ${command.scope} usage to ${requested}. ${summary}`, "info");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        ctx.ui.notify(code === "EEXIST" ? "Export destination already exists. Choose a new file." : "Could not create usage export. Check the destination directory and permissions.", "error");
      }
    },
  });
}
