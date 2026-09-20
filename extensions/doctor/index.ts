import * as tui from "@earendil-works/pi-tui";
import { VERSION, getAgentDir, getShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTelegramConfig } from "../telegram/config.ts";
import { SnapshotPanel } from "../../lib/transcript/snapshot-panel.ts";
import { diagnose, formatReport } from "./checks.ts";
import { reportBlocks } from "./report.ts";

export default function doctorExtension(pi: ExtensionAPI, deps: { diagnose?: typeof diagnose } = {}): void {
  const inspect = deps.diagnose ?? diagnose;
  const panel = new SnapshotPanel(pi, "doctor", "Doctor · local checks");
  let generation = 0;
  let open = false;
  const reset = () => { generation++; open = false; };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);
  pi.registerCommand("doctor", {
    description: "Read-only dependency and configuration checks: /doctor [text]",
    async handler(args, ctx) {
      if (args.trim() && args.trim() !== "text") { ctx.ui.notify("Usage: /doctor [text]", "info"); return; }
      if (open) return;
      open = true;
      const version = generation;
      try {
        let shell: string | undefined;
        try { shell = getShellConfig().shell; } catch {}
        const commands = pi.getCommands().map((command) => command.name);
        const findings = await inspect({ hostVersion: VERSION,
          modelAuthConfigured: ctx.model ? ctx.modelRegistry?.hasConfiguredAuth?.(ctx.model) : undefined,
          modelConfigInvalid: ctx.modelRegistry?.getError ? !!ctx.modelRegistry.getError() : undefined,
          bindingConflicts: ctx.mode === "tui" ? tui.getKeybindings?.().getConflicts().length : undefined,
          platform: process.platform, bun: !!process.versions.bun, env: process.env, agentDir: getAgentDir(),
          tools: pi.getAllTools().map((tool) => tool.name), activeTools: pi.getActiveTools(), commands, shell, model: ctx.model,
          telegram: commands.includes("telegram") ? loadTelegramConfig({ cwd: ctx.cwd }).status : "disabled" });
        if (version !== generation) return;
        if (ctx.mode !== "tui" || args.trim() === "text") { ctx.ui.notify(formatReport(findings), "info"); return; }
        await panel.open(ctx, reportBlocks(findings));
      } catch {
        if (version === generation) ctx.ui.notify("Doctor could not finish local checks. Check that the Pi agent directory is readable and try again.", "error");
      } finally { if (version === generation) open = false; }
    },
  });
}
