import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { STATE_TYPE, referenceOlderImages, restoreEnabled, retrieveImage } from "./history.ts";

export default function imageHistory(pi: ExtensionAPI): void {
  let enabled = false;
  let replaced = 0;
  const sync = (ctx: ExtensionContext) => {
    const active = pi.getActiveTools();
    pi.setActiveTools(enabled ? [...new Set([...active, "history_image"])] : active.filter((name) => name !== "history_image"));
    if (ctx.hasUI) ctx.ui.setStatus("image-history", enabled ? `images: ${replaced} deferred` : undefined);
  };
  const restore = (ctx: ExtensionContext) => { enabled = restoreEnabled(ctx.sessionManager.getBranch()); replaced = 0; sync(ctx); };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => { enabled = false; if (ctx.hasUI) ctx.ui.setStatus("image-history", undefined); });
  pi.on("context", (event, ctx) => {
    if (!enabled) return;
    const result = referenceOlderImages(event.messages, ctx.sessionManager.getBranch());
    replaced = result.replaced;
    if (ctx.hasUI) ctx.ui.setStatus("image-history", `images: ${replaced} deferred`);
    return { messages: result.messages };
  });
  pi.registerCommand("image-history", {
    description: "Defer older images from model context: /image-history on|off|status",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "on" || command === "off") {
        const next = command === "on";
        pi.appendEntry(STATE_TYPE, { version: 1, enabled: next });
        enabled = next;
        replaced = 0;
        sync(ctx);
      } else if (command && command !== "status") {
        ctx.ui.notify("Usage: /image-history on|off|status", "error");
        return;
      }
      ctx.ui.notify(enabled ? `Image history on: ${replaced} images deferred in the last request. Original images remain in the session and are retrievable with history_image.` : "Image history off: images follow Pi's normal context policy.", "info");
    },
  });
  pi.registerTool({
    name: "history_image",
    label: "Retrieve history image",
    description: "Retrieve one earlier image by the exact reference shown in a model-context placeholder. Requires image-history mode.",
    parameters: { type: "object", properties: { reference: { type: "string", minLength: 3, maxLength: 256 } }, required: ["reference"], additionalProperties: false } as any,
    async execute(_id, params: { reference: string }, signal, _update, ctx) {
      if (!enabled) throw new Error("Image history is disabled. The user can enable it with /image-history on.");
      if (signal?.aborted) throw new Error("Image retrieval cancelled.");
      const image = retrieveImage(ctx.sessionManager.getBranch(), params.reference);
      if (!image) throw new Error("Image reference not found on the current branch.");
      return { content: [{ type: "text", text: `Earlier image ${params.reference}` }, image], details: { reference: params.reference } };
    },
  });
}
