import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFERRAL_BATCH, STATE_TYPE, referenceOlderImages, restoreEnabled, retrieveImage } from "./history.ts";
import { ImageStore, ORIGINAL_IMAGE, originalReference } from "./storage.ts";
import { exportPortableSession, hasStorableImage, hydrateImages, restoreStorageEnabled, STORAGE_STATE_TYPE, storeMessage, storedImages } from "./pipeline.ts";
import { inspectStorage, originalFiles, removeUnusedOriginals } from "./cleanup.ts";
import { OriginalImageViewer, prepareImageForViewer } from "./viewer.ts";
import { loadConfig, storageSupported, type ImageHistoryConfig } from "./config.ts";
import { LEGACY_PREVIEW_ENTRY, LegacyImagePreview, LegacyImageStore, legacyReference, restoreLegacyMessages, restoreLegacyTranscript } from "./legacy.ts";
import { PlainOutput } from "../../lib/output.ts";
import { toolHeadline, toolText } from "../../lib/tool-ui.ts";

const oneLine = (value: unknown) => new PlainOutput().push(typeof value === "string" ? value : "").replace(/\s+/g, " ").trim().slice(0, 256);
/** A one-line card; Pi still renders the retrieved image natively below it. */
export const historyImageRenderers = {
  renderShell: "self" as const,
  renderCall: (args: unknown, theme: Theme, context?: { isPartial?: boolean; isError?: boolean }) =>
    toolHeadline(context?.isError ? "Image retrieval failed" : context?.isPartial ? "Retrieving image" : "Retrieved image", oneLine((args as { reference?: unknown } | undefined)?.reference), theme, context?.isError),
  renderResult: (result: { content: readonly { type: string; text?: string }[] }, options: { isPartial: boolean }, theme: Theme, context?: { isError?: boolean }) => {
    const error = context?.isError && !options.isPartial ? oneLine(result.content.find((part) => part.type === "text")?.text) : "";
    return error ? toolText(`${theme.fg("dim", "  └ ")}${theme.fg("error", error)}`, true) : { invalidate() {}, render: () => [] };
  },
};

export interface ImageHistoryOptions { agentDir?: string; config?: ImageHistoryConfig }

export default function imageHistory(pi: ExtensionAPI, options: ImageHistoryOptions = {}): void {
  const agentDir = options.agentDir ?? getAgentDir();
  const config = options.config ?? loadConfig(agentDir);
  let enabled = false;
  let replaced = 0;
  let storageEnabled = false;
  let generation = 0;
  let warned = false;
  let exportAbort: AbortController | undefined;
  let cleanupAbort: AbortController | undefined;
  let closeViewer: (() => void) | undefined;
  const store = new ImageStore(join(agentDir, "image-store"));
  const legacy = new LegacyImageStore(agentDir);
  const legacyWarning = (ctx: ExtensionContext, version: number) => () => {
    if (version === generation) warning(ctx, "A stored image from an earlier session is unavailable; a note marks its place.");
  };
  const rememberSession = async (ctx: ExtensionContext) => {
    await store.rememberSessionDirectory(ctx.sessionManager.getSessionDir());
    const file = ctx.sessionManager.getSessionFile();
    if (file) await store.rememberSessionFile(file);
  };
  const warning = (ctx: ExtensionContext, message: string) => { if (!warned) { warned = true; ctx.ui.notify(message, "warning"); } };
  const sync = (ctx: ExtensionContext) => {
    const active = pi.getActiveTools();
    pi.setActiveTools(enabled ? [...new Set([...active, "history_image"])] : active.filter((name) => name !== "history_image"));
    if (ctx.hasUI) ctx.ui.setStatus("image-history", enabled ? `images: ${replaced} deferred` : undefined);
  };
  const restore = async (ctx: ExtensionContext) => {
    generation++; exportAbort?.abort(); exportAbort = undefined; store.clearCache(); legacy.clearCache(); warned = false;
    cleanupAbort?.abort(); cleanupAbort = undefined; closeViewer?.(); closeViewer = undefined;
    const entries = ctx.sessionManager.getBranch();
    enabled = restoreEnabled(entries, config.deferral);
    storageEnabled = restoreStorageEnabled(entries, config.storage && storageSupported()); replaced = 0; sync(ctx);
    const version = generation;
    if (ctx.mode === "tui") restoreLegacyTranscript(entries, legacy, legacyWarning(ctx, version));
    // A global default alone never creates the store; the first storable image does.
    if (restoreStorageEnabled(entries) || storedImages(entries).length) {
      try { await rememberSession(ctx); }
      catch { if (version === generation) warning(ctx, "Image session directory could not be recorded; new originals will stay embedded until storage is available."); }
    }
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    generation++; enabled = false; storageEnabled = false; store.clearCache(); legacy.clearCache(); exportAbort?.abort();
    cleanupAbort?.abort(); closeViewer?.(); closeViewer = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("image-history", undefined);
  });
  pi.on("message_end", async (event, ctx) => {
    if (!storageEnabled || !["user", "toolResult"].includes(event.message.role)
      || !hasStorableImage(event.message)) return;
    const version = generation;
    try { await rememberSession(ctx); }
    catch { if (version === generation) warning(ctx, "Image storage unavailable; this image remains embedded."); return; }
    const message = await storeMessage(event.message, store, () => { if (version === generation) warning(ctx, "Image storage unavailable; this image remains embedded."); });
    if (version === generation && message !== event.message) return { message };
  });
  pi.on("context", async (event, ctx) => {
    const version = generation;
    const entries = ctx.sessionManager.getBranch();
    const messages = restoreLegacyMessages(event.messages, legacy, legacyWarning(ctx, version));
    const result = enabled ? referenceOlderImages(messages, entries, config.batch ?? DEFERRAL_BATCH) : { messages, replaced: 0 };
    replaced = result.replaced;
    if (enabled && ctx.hasUI) ctx.ui.setStatus("image-history", `images: ${replaced} deferred`);
    return { messages: await hydrateImages(result.messages, entries, store,
      () => { if (version === generation) warning(ctx, "An original image is unavailable. Pi and the model retain its labeled preview; portable export requires the original."); }) };
  });
  pi.registerEntryRenderer(LEGACY_PREVIEW_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { version?: unknown; ref?: unknown; label?: unknown } | undefined;
    const ref = data?.version === 1 ? legacyReference(data.ref) : undefined;
    return ref ? new LegacyImagePreview(ref, typeof data!.label === "string" ? data!.label : undefined, legacy, theme) : undefined;
  });
  pi.registerCommand("image-store", {
    description: "Original images: on|off|status|list|view <reference>|export [path]|gc [session directory]",
    getArgumentCompletions: (prefix) => {
      const matches = ["on", "off", "status", "stats", "list", "view", "export", "gc"].filter((value) => value.startsWith(prefix));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const [action = "status"] = args.trim().split(/\s+/);
      if (action === "view") {
        if (ctx.mode !== "tui") { ctx.ui.notify("Original image viewing requires Pi's terminal UI. Use portable export outside the terminal.", "info"); return; }
        const version = generation;
        try {
          const reference = args.trim().slice(action.length).trim();
          const part = retrieveImage(ctx.sessionManager.getBranch(), reference);
          if (!part) throw new Error("Use /image-store view <reference> with a reference from /image-store list.");
          const image = await prepareImageForViewer(part[ORIGINAL_IMAGE] === undefined ? part : await store.unpack(part));
          if (version !== generation) return;
          closeViewer?.();
          await ctx.ui.custom<void>((tui, theme, _keys, done) => {
            closeViewer = done;
            return new OriginalImageViewer(image, reference, theme, tui.terminal.rows, done);
          });
          if (version === generation) closeViewer = undefined;
        } catch (error) { if (version === generation) ctx.ui.notify(error instanceof Error ? error.message : "Image viewing failed.", "warning"); }
        return;
      }
      if (action === "gc") {
        if (cleanupAbort) { ctx.ui.notify("Image cleanup is already running.", "info"); return; }
        const abort = new AbortController(), version = generation;
        cleanupAbort = abort;
        try {
          await rememberSession(ctx);
          const extra = args.trim().slice(action.length).trim();
          if (extra) await store.rememberSessionDirectory(resolve(ctx.cwd, extra));
          const sessions = join(agentDir, "sessions");
          const inventory = await inspectStorage(store, sessions, abort.signal);
          if (version !== generation) return;
          const bytes = inventory.candidates.reduce((sum, file) => sum + file.bytes, 0);
          const description = `${inventory.candidates.length} unused originals · ${(bytes / 1024 / 1024).toFixed(1)} MiB · ${inventory.sessionFiles} sessions scanned`;
          if (!inventory.candidates.length || ctx.mode !== "tui") { ctx.ui.notify(description + (ctx.mode !== "tui" ? ". Deletion requires terminal confirmation." : ". Nothing to remove."), "info"); return; }
          const confirmed = await ctx.ui.confirm("Remove unused original images?", `${description}\nOnly files unused for at least 48 hours are eligible. All branches in these directories were scanned:\n${inventory.directories.join("\n")}\nCopies kept elsewhere must be included with /image-store gc <session directory>.`);
          if (!confirmed || version !== generation || abort.signal.aborted) return;
          const result = await removeUnusedOriginals(store, sessions, inventory.candidates, abort.signal);
          if (version === generation) ctx.ui.notify(`Removed ${result.files} unused originals · ${(result.bytes / 1024 / 1024).toFixed(1)} MiB reclaimed.`, "info");
        } catch (error) { if (version === generation && !abort.signal.aborted) ctx.ui.notify(`Image cleanup stopped: ${error instanceof Error ? error.message : "unknown error"}`, "warning"); }
        finally { if (cleanupAbort === abort) cleanupAbort = undefined; }
        return;
      }
      if (action === "on" || action === "off") {
        if (args.trim() !== action) { ctx.ui.notify("Usage: /image-store on|off", "warning"); return; }
        pi.appendEntry(STORAGE_STATE_TYPE, { version: 1, enabled: action === "on" });
        storageEnabled = action === "on"; warned = false;
      } else if (action === "export") {
        if (exportAbort) { ctx.ui.notify("An image export is already running.", "warning"); return; }
        const version = generation;
        const abort = new AbortController(); exportAbort = abort;
        try {
          const supplied = args.trim().slice(action.length).trim();
          const exportsDirectory = join(agentDir, "exports");
          if (!supplied) await mkdir(exportsDirectory, { recursive: true, mode: 0o700 });
          const destination = supplied ? resolve(ctx.cwd, supplied)
            : join(exportsDirectory, `${ctx.sessionManager.getSessionId()}-${Date.now()}.portable.jsonl`);
          const result = await exportPortableSession(ctx.sessionManager.getHeader(), [...ctx.sessionManager.getEntries()], destination, store, abort.signal);
          if (version === generation) ctx.ui.notify(`Portable session saved: ${destination} · ${result.images} originals embedded`, "info");
        } catch (error) {
          if (version === generation && !abort.signal.aborted) ctx.ui.notify(`Portable export failed: ${error instanceof Error ? error.message : "unknown error"}`, "error");
        } finally { if (exportAbort === abort) exportAbort = undefined; }
        return;
      } else if (!["status", "stats", "list"].includes(action) || args.trim() && args.trim() !== action) {
        ctx.ui.notify("Usage: /image-store on|off|status|list|view <reference>|export [path]|gc [session directory]", "warning"); return;
      }
      const images = storedImages(ctx.sessionManager.getBranch());
      const originals = new Set(images.map(({ image }) => originalReference(image)!.hash));
      if (action === "list") {
        ctx.ui.notify(images.length ? images.slice(-12).map(({ reference, image }) => `${reference} · ${originalReference(image)!.mimeType} · ${Math.ceil(originalReference(image)!.bytes / 1024)} KB original`).join("\n") : "No stored images on this branch.", "info");
      } else {
        try {
          const files = await originalFiles(store);
          const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
          ctx.ui.notify(`Image storage ${storageEnabled ? "on" : "off"} · ${images.length} previews · ${originals.size} unique originals on this branch\nStore: ${files.length} files · ${(bytes / 1024 / 1024).toFixed(1)} MiB · ${store.blobsDirectory}`, "info");
        } catch { ctx.ui.notify("Image store could not be inspected.", "warning"); }
      }
    },
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
    ...historyImageRenderers,
    description: "Retrieve one earlier image by the exact reference shown in a model-context placeholder. Requires image-history mode.",
    parameters: { type: "object", properties: { reference: { type: "string", minLength: 3, maxLength: 256 } }, required: ["reference"], additionalProperties: false } as any,
    async execute(_id, params: { reference: string }, signal, _update, ctx) {
      if (!enabled) throw new Error("Image history is disabled. The user can enable it with /image-history on.");
      if (signal?.aborted) throw new Error("Image retrieval cancelled.");
      const part = retrieveImage(ctx.sessionManager.getBranch(), params.reference);
      const image = part?.[ORIGINAL_IMAGE] === undefined ? part : await store.unpack(part);
      if (!image) throw new Error("Image reference not found on the current branch.");
      return { content: [{ type: "text", text: `Earlier image ${params.reference}` }, image], details: { reference: params.reference } };
    },
  });
}
