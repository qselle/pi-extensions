import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface ModelLike { provider: string; api: string; id: string; baseUrl: string }
export function supportsFastMode(model: ModelLike | undefined): boolean {
  if (!model || model.id.startsWith("ft:")) return false;
  try {
    const url = new URL(model.baseUrl);
    if (url.username || url.password || url.search || url.hash) return false;
    if (model.provider === "openai" && model.api === "openai-responses") {
      return url.origin === "https://api.openai.com" && /^\/v1\/?$/.test(url.pathname);
    }
    return model.provider === "openai-codex" && model.api === "openai-codex-responses"
      && url.origin === "https://chatgpt.com" && /^\/backend-api(?:\/codex(?:\/responses)?)?\/?$/.test(url.pathname);
  } catch { return false; }
}
const key = (model: ModelLike) => `${model.provider}/${model.api}/${model.id}/${model.baseUrl}`;

export default function fastMode(pi: ExtensionAPI): void {
  let enabledFor: string | undefined;
  const reset = (ctx: ExtensionContext) => {
    enabledFor = undefined;
    ctx.ui.setStatus("fast-mode", undefined);
  };
  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => reset(ctx));
  pi.on("model_select", (_event, ctx) => reset(ctx));
  pi.registerCommand("fast", {
    description: "Request premium OpenAI fast processing for the current model: /fast on|off|status",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "off") {
        reset(ctx);
        ctx.ui.notify("Fast-mode override off. Provider/project defaults apply.", "info");
        return;
      }
      if (command === "on") {
        if (!supportsFastMode(ctx.model)) {
          ctx.ui.notify("Fast mode requires a direct OpenAI Responses or ChatGPT Codex endpoint. This provider, endpoint or model is not supported by this extension.", "warning");
          return;
        }
        enabledFor = key(ctx.model!);
        ctx.ui.setStatus("fast-mode", "fast: requested");
        const usage = ctx.model!.provider === "openai-codex" ? "Increased ChatGPT credit consumption may apply" : "Premium API pricing applies";
        ctx.ui.notify(`Fast processing requested for this model. ${usage}; provider eligibility and actual tier are not guaranteed. Model/session changes turn this override off.`, "info");
        return;
      }
      if (command && command !== "status") {
        ctx.ui.notify("Usage: /fast on|off|status", "error");
        return;
      }
      ctx.ui.notify(enabledFor && ctx.model && enabledFor === key(ctx.model)
        ? "Fast processing requested for this model; actual service tier is determined by the provider."
        : "Fast-mode override off. Provider/project defaults apply.", "info");
    },
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!enabledFor || !supportsFastMode(ctx.model) || key(ctx.model!) !== enabledFor) return;
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const request = payload as Record<string, unknown>;
    if (request.model !== ctx.model!.id) return;
    // Use the documented priority alias understood by the installed Pi adapter.
    // Return a replacement so other extension references are not mutated.
    return { ...request, service_tier: "priority" };
  });
}
