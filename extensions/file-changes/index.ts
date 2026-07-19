import {
  generateUnifiedPatch,
  isEditToolResult,
  isToolCallEventType,
  isWriteToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerOverlayCard } from "../overlay-stack/index.ts";
import {
  FILE_CHANGES_ENTRY_TYPE,
  FILE_CHANGES_ENTRY_VERSION,
  FileChangeRun,
  countChangedLines,
  restoreFileChanges,
  type FileChange,
  type StoredFileChanges,
} from "./changes.ts";
import { fileChangesTitle, renderFileChangesBody, type FileChangesDisplay } from "./ui.ts";

const CARD_ID = "file-changes";
const countContentChanges = (path: string, before: string, after: string) =>
  countChangedLines(generateUnifiedPatch(path, before, after, 0));

export default function fileChangesExtension(pi: ExtensionAPI): void {
  let enabled = true;
  let activeRun: FileChangeRun | undefined;
  let display: FileChangesDisplay = { phase: "last", files: [] };

  const card = registerOverlayCard({
    id: CARD_ID,
    order: 20,
    width: 58,
    minBodyHeight: 3,
    minTerminalWidth: 72,
    minTerminalHeight: 12,
    visible: () => enabled && display.files.length > 0,
    title: (theme) => fileChangesTitle(display, theme),
    renderBody: (width, maxHeight, theme) => renderFileChangesBody(display, width, maxHeight, theme),
  });

  const invalidate = () => card.invalidate();
  const beginRun = () => {
    if (activeRun) return;
    activeRun = new FileChangeRun(countContentChanges);
    display = { phase: "live", files: [] };
    invalidate();
  };
  const refreshDisplay = () => {
    if (!activeRun) return;
    display = { phase: "live", files: activeRun.files() };
    invalidate();
  };
  const finishRun = () => {
    if (!activeRun) return;
    const files = activeRun.files();
    display = { phase: "last", files };
    const state: StoredFileChanges = {
      version: FILE_CHANGES_ENTRY_VERSION,
      files,
      completedAt: Date.now(),
    };
    pi.appendEntry(FILE_CHANGES_ENTRY_TYPE, state);
    activeRun = undefined;
    invalidate();
  };
  const restore = (ctx: ExtensionContext) => {
    activeRun = undefined;
    const state = restoreFileChanges(ctx.sessionManager.getBranch());
    display = { phase: "last", files: state?.files ?? [] };
    invalidate();
  };
  const setEnabled = (next: boolean, ctx: ExtensionContext) => {
    enabled = next;
    invalidate();
    ctx.ui.notify(`Changed-files card ${enabled ? "shown" : "hidden"}.`, "info");
  };

  pi.registerCommand("file-changes", {
    description: "Show, hide, or inspect the changed-files overlay card: /file-changes [toggle|show|hide|status]",
    getArgumentCompletions: (prefix) => {
      const values = ["toggle", "show", "hide", "status"];
      const matches = values.filter((value) => value.startsWith(prefix.trim().toLowerCase()));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: (args, ctx) => {
      const action = args.trim().toLowerCase() || "toggle";
      if (action === "toggle") setEnabled(!enabled, ctx);
      else if (action === "show") setEnabled(true, ctx);
      else if (action === "hide") setEnabled(false, ctx);
      else if (action === "status") {
        const fileCount = display.files.length;
        ctx.ui.notify(
          `Changed-files card is ${enabled ? "shown" : "hidden"}; ${fileCount} ${fileCount === 1 ? "file" : "files"} from the ${display.phase === "live" ? "active" : "last"} run.`,
          "info",
        );
      } else {
        ctx.ui.notify("Usage: /file-changes [toggle|show|hide|status]", "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.on("before_agent_start", () => beginRun());

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
    beginRun();
    await activeRun?.captureBaseline(ctx.cwd, event.input.path);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!isEditToolResult(event) && !isWriteToolResult(event)) return;
    if (event.isError || typeof event.input.path !== "string" || !activeRun) return;
    await activeRun.refresh(ctx.cwd, event.input.path);
    refreshDisplay();
  });

  pi.on("agent_settled", () => finishRun());

  pi.on("session_shutdown", () => {
    finishRun();
    card.unregister();
  });
}

export type { FileChange };
