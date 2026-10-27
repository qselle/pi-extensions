import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface ModelLike { provider: string; api: string; id: string }
const BADGE = "fast-mode";

/** Protocols that understand `service_tier`; the API decides model and account eligibility. */
export function supportsFastMode(model: ModelLike | undefined): boolean {
  return model?.provider === "openai" && model.api === "openai-responses"
    || model?.provider === "openai-codex" && model.api === "openai-codex-responses";
}

/** Explicit tier rejections only; rate limits, timeouts and unrelated 400s do not match. */
export function isPriorityRejection(error: string): boolean {
  return /\b(?:service[_ -]tier|priority(?: service(?: tier)?)?)(?:\s*:\s*['"]?priority['"]?)?\s+(?:is\s+)?(?:unsupported|not supported|unavailable|not available|not allowed|not enabled|disallowed)\b/i.test(error)
    || /\b(?:unsupported|unavailable|disallowed)\s+['"]?(?:service[_ -]tier|priority)\b/i.test(error)
    || /\b(?:invalid|unknown|unrecognized)\s+(?:parameter\s*:\s*)?['"]?service[_ -]tier\b/i.test(error);
}

function loadEnabled(path: string): boolean {
  try { return JSON.parse(readFileSync(path, "utf8"))?.enabled === true; } catch { return false; }
}

export interface FastModeOptions { configPath?: string }

export default function fastMode(pi: ExtensionAPI, options: FastModeOptions = {}): void {
  const configPath = options.configPath ?? join(getAgentDir(), "fast-mode.json");
  let enabled = loadEnabled(configPath);
  /** `provider/model` of the request awaiting its response, and of the last explicit rejection. */
  let requested: string | undefined;
  let rejected: string | undefined;
  const id = (model: { provider: string; id?: string; model?: string }) => `${model.provider}/${model.id ?? model.model}`;
  const active = (ctx: ExtensionContext) => enabled && supportsFastMode(ctx.model);
  const badge = (ctx?: ExtensionContext) => {
    const text = ctx && active(ctx) ? rejected === id(ctx.model!) ? "fast unavailable" : "fast" : undefined;
    pi.events.emit("footer:badge", text ? { id: BADGE, text, order: -10 } : { id: BADGE });
  };
  const reset = (_event: unknown, ctx: ExtensionContext) => {
    requested = rejected = undefined;
    badge(ctx);
  };
  const describe = (ctx: ExtensionContext): string => {
    if (!enabled) return "Fast mode is off; provider/project defaults apply.";
    if (!supportsFastMode(ctx.model)) return "Fast mode is on, but this model's provider does not accept service_tier; requests are unchanged.";
    if (rejected === id(ctx.model!)) return "Fast mode is on, but the provider rejected the last priority request. The next request still asks for priority; use /fast off to stop.";
    const usage = ctx.model!.provider === "openai-codex" ? "Increased ChatGPT credit consumption may apply" : "Premium API pricing applies";
    return `Fast mode is on: requests ask for priority processing. ${usage}; the provider decides eligibility and the actual tier.`;
  };
  pi.on("session_start", reset);
  pi.on("model_select", reset);
  pi.on("session_shutdown", () => { requested = rejected = undefined; badge(); });
  pi.registerCommand("fast", {
    description: "Request premium OpenAI fast processing: /fast on|off|status",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "on" || command === "off") {
        enabled = command === "on";
        try {
          mkdirSync(dirname(configPath), { recursive: true });
          writeFileSync(configPath, `${JSON.stringify({ enabled }, null, 2)}\n`);
        } catch {
          ctx.ui.notify(`Could not save ${configPath}; fast mode is ${command} for this session only.`, "warning");
        }
        reset(undefined, ctx);
      } else if (command && command !== "status") {
        ctx.ui.notify("Usage: /fast on|off|status", "error");
        return;
      }
      ctx.ui.notify(describe(ctx), "info");
    },
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!active(ctx)) return;
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const request = payload as Record<string, unknown>;
    if (request.model !== ctx.model!.id) return;
    requested = id(ctx.model!);
    if (rejected === requested) { rejected = undefined; badge(ctx); }
    // Use the documented priority alias understood by the installed Pi adapter.
    // Return a replacement so other extension references are not mutated.
    return { ...request, service_tier: "priority" };
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || !requested || id(message) !== requested) return;
    requested = undefined;
    if (message.stopReason !== "error" || !isPriorityRejection(message.errorMessage ?? "")) return;
    rejected = id(message);
    badge(ctx);
    ctx.ui.notify("The provider rejected the priority request. Fast mode stays on; use /fast off to stop requesting it. No fallback request was sent.", "warning");
  });
}
