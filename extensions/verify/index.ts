import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  emptyConfig,
  loadConfig,
  matchCheck,
  relativePosixPath,
  type VerifyConfig,
} from "./config.ts";
import { VerifyCache, runCheck, type CheckOutcome, type Exec } from "./runner.ts";

const STATUS_KEY = "verify-running";
const WATCHED_TOOLS = new Set(["edit", "write"]);

export interface VerifyExtensionOptions {
  loadConfiguration?: typeof loadConfig;
  exec?: Exec;
  agentDir?: string;
}

export default function verifyExtension(pi: ExtensionAPI, options: VerifyExtensionOptions = {}): void {
  const load = options.loadConfiguration ?? loadConfig;
  const cache = new VerifyCache();
  let config: VerifyConfig = emptyConfig();
  let sessionEnabled = true;
  let cwd = process.cwd();
  let last: CheckOutcome | undefined;

  const exec: Exec = options.exec
    ?? ((command, args, execOptions) => pi.exec(command, args, execOptions) as unknown as ReturnType<Exec>);

  const refresh = (ctx: ExtensionContext) => {
    cwd = ctx.cwd;
    config = load({
      cwd: ctx.cwd,
      // Project config is an executable command, so it is only honored when trusted.
      projectTrusted: ctx.isProjectTrusted?.() ?? false,
      agentDir: options.agentDir,
    });
    cache.clear();
  };

  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("session_tree", (_event, ctx) => refresh(ctx));
  // Results are only reused inside one turn; a new turn always re-verifies.
  pi.on("turn_start", () => cache.clear());

  pi.on("tool_result", async (event: any, ctx: any) => {
    if (!sessionEnabled || !config.enabled) return undefined;
    if (!WATCHED_TOOLS.has(event.toolName)) return undefined;
    // The write itself failed; there is nothing new on disk to verify.
    if (event.isError) return undefined;

    const rawPath = event.input?.path;
    if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;
    const file = relativePosixPath(rawPath, cwd);
    const check = matchCheck(config, file);
    if (!check) return undefined;

    const hasUI = Boolean(ctx?.hasUI);
    if (hasUI) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `verifying ${check.name}…`));
    try {
      const outcome = await runCheck({
        check,
        file,
        cwd,
        spillTokenLimit: config.spillTokenLimit,
        exec,
        signal: ctx?.signal,
        cache,
      });
      last = outcome;
      if (outcome.ok || !outcome.text) return undefined;
      // Append to the existing result; never set isError, because the edit did apply.
      return { content: [...(event.content ?? []), { type: "text", text: outcome.text }] };
    } finally {
      if (hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  pi.registerCommand("verify", {
    description: "Inspect or toggle post-edit verification: /verify [status|on|off|run <path>]",
    getArgumentCompletions: (prefix) => {
      const items = ["status", "on", "off", "run"]
        .filter((value) => value.startsWith(prefix.toLowerCase()))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const [command = "", ...rest] = args.trim().split(/\s+/);
      const action = command.toLowerCase();

      if (action === "on" || action === "off") {
        sessionEnabled = action === "on";
        ctx.ui.notify(`Verification ${sessionEnabled ? "enabled" : "disabled"} for this session.`, "info");
        return;
      }

      if (action === "run") {
        const target = rest.join(" ").trim();
        if (!target) {
          ctx.ui.notify("Usage: /verify run <path>", "error");
          return;
        }
        const file = relativePosixPath(target, ctx.cwd);
        const check = matchCheck(config, file);
        if (!check) {
          ctx.ui.notify(`No check matches ${file}.`, "info");
          return;
        }
        const outcome = await runCheck({
          check, file, cwd: ctx.cwd, spillTokenLimit: config.spillTokenLimit, exec, signal: ctx.signal,
        });
        last = outcome;
        ctx.ui.notify(
          outcome.ok
            ? `${check.name} passed (${outcome.durationMs}ms): ${outcome.command}`
            : (outcome.text ?? "check failed").trim(),
          outcome.ok ? "info" : "error",
        );
        return;
      }

      if (action && action !== "status") {
        ctx.ui.notify("Usage: /verify [status|on|off|run <path>]", "error");
        return;
      }
      ctx.ui.notify(statusText(config, sessionEnabled, last), "info");
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    cache.clear();
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

export function statusText(config: VerifyConfig, sessionEnabled: boolean, last?: CheckOutcome): string {
  const lines = [
    `verification: ${sessionEnabled && config.enabled ? "on" : "off"}`,
    `config: ${config.source}`,
  ];
  if (config.untrustedProjectConfig) {
    lines.push("warning: .pi/verify.json was ignored because this project is not trusted (/trust to allow)");
  }
  if (config.checks.length === 0) lines.push("no checks configured");
  for (const check of config.checks) {
    lines.push(`  ${check.name}: ${check.match.join(", ")} -> ${check.command} (${check.timeoutMs}ms)`);
  }
  if (last) {
    lines.push(
      `last: ${last.checkName} ${last.ok ? "passed" : `failed (exit ${last.code ?? "unknown"})`}`
        + ` in ${last.durationMs}ms${last.cached ? " (cached)" : ""}`,
    );
  }
  return lines.join("\n");
}
