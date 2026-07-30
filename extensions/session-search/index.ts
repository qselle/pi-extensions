import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, SessionInfo } from "@earendil-works/pi-coding-agent";
import * as CodingAgent from "@earendil-works/pi-coding-agent";
import { copyText } from "./clipboard.ts";
import {
  compactPath,
  parseSessionSearchArgs,
  resultDetails,
  resultLabel,
  searchSessions,
  selectCurrentProjectSessions,
  type CurrentProjectSelection,
  type ParsedSessionSearchArgs,
  type SessionSearchSummary,
} from "./search.ts";

const STATUS_KEY = "session-search";

interface OpenedSession {
  getEntry(id: string): unknown;
  getLeafId(): string | null;
  createBranchedSession(leafId: string): string | undefined;
}

interface SessionManagerHost {
  listAll(onProgress?: (loaded: number, total: number) => void): Promise<SessionInfo[]>;
  open(path: string): OpenedSession;
}

export interface SessionSearchExtensionOptions {
  listSessions?: (onProgress?: (loaded: number, total: number) => void) => Promise<SessionInfo[]>;
  openSession?: (path: string) => OpenedSession;
  search?: typeof searchSessions;
  selectCurrent?: typeof selectCurrentProjectSessions;
  copy?: typeof copyText;
  removeFile?: (path: string) => Promise<void>;
}

export default function sessionSearchExtension(
  pi: ExtensionAPI,
  options: SessionSearchExtensionOptions = {},
): void {
  // Namespace access remains test-order safe when another extension test installs
  // a deliberately partial process-wide mock of the Pi package.
  const hostSessionManager = (CodingAgent as unknown as { SessionManager?: SessionManagerHost }).SessionManager;
  const listSessions = options.listSessions ?? ((onProgress) => requireSessionManager(hostSessionManager).listAll(onProgress));
  const openSession = options.openSession ?? ((path) => requireSessionManager(hostSessionManager).open(path));
  const search = options.search ?? searchSessions;
  const selectCurrent = options.selectCurrent ?? selectCurrentProjectSessions;
  const copy = options.copy ?? copyText;
  const removeFile = options.removeFile ?? ((path) => unlink(path));

  pi.registerCommand("session-search", {
    description: "Search saved Pi sessions: /session-search [--current|--all] <query>",
    getArgumentCompletions: (prefix) => {
      const fragment = prefix.trimStart();
      if (fragment.includes(" ")) return null;
      const items = ["--current", "--all"]
        .filter((value) => value.startsWith(fragment))
        .map((value) => ({ value: `${value} `, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Session search requires interactive TUI mode.", "error");
        return;
      }

      let switched = false;
      try {
        let parsed = parseSessionSearchArgs(args);
        if (!parsed.query) {
          const input = await ctx.ui.input("Search saved Pi sessions", "keywords, optionally --current");
          if (!input?.trim()) return;
          parsed = parseSessionSearchArgs(`${parsed.scope === "current" ? "--current " : ""}${input}`);
        }
        if (!parsed.query) return;

        setStatus(ctx, "loading saved sessions…");
        const sessions = await listSessions((loaded, total) => {
          if (loaded === total || loaded % 25 === 0) setStatus(ctx, `loading sessions ${loaded}/${total}…`);
        });
        const selection = selectScope(sessions, parsed, ctx.cwd, selectCurrent);
        if (selection.sessions.length === 0) {
          ctx.ui.notify(
            parsed.scope === "current"
              ? `No saved sessions belong to the current project (${compactPath(selection.projectRoot)}).`
              : "No saved Pi sessions were found.",
            "info",
          );
          return;
        }

        const summary = await search(selection.sessions, parsed.query, {
          onProgress: (completed, total) => {
            if (completed === total || completed % 8 === 0) setStatus(ctx, `searching sessions ${completed}/${total}…`);
          },
        });
        if (summary.results.length === 0) {
          ctx.ui.notify(noMatchesMessage(parsed, selection, summary), "info");
          return;
        }

        const choices = summary.results.map((result, index) => resultLabel(result, index));
        const selectedLabel = await ctx.ui.select(
          `Session matches for “${parsed.query}” (${summary.results.length})`,
          choices,
        );
        if (!selectedLabel) return;
        const selectedIndex = choices.indexOf(selectedLabel);
        const selected = summary.results[selectedIndex];
        if (!selected) return;

        const action = await ctx.ui.select(resultDetails(selected), [
          "Resume this session",
          "Fork through the matching entry",
          "Copy matching excerpt",
          "Put excerpt in editor",
          "Cancel",
        ]);
        if (!action || action === "Cancel") return;

        if (action === "Resume this session") {
          const currentPath = ctx.sessionManager?.getSessionFile?.();
          if (currentPath && resolve(currentPath) === resolve(selected.session.path)) {
            ctx.ui.notify("This is already the active session.", "info");
            return;
          }
          const query = parsed.query;
          const result = await ctx.switchSession(selected.session.path, {
            withSession: async (replacementCtx) => {
              replacementCtx.ui.notify(`Resumed match for “${query}”.`, "info");
            },
          });
          if (result.cancelled) {
            ctx.ui.notify("Session switch was cancelled.", "warning");
            return;
          }
          switched = true;
          return;
        }

        if (action === "Fork through the matching entry") {
          const source = openSession(selected.session.path);
          const matchingEntry = selected.entryId && source.getEntry(selected.entryId) ? selected.entryId : undefined;
          const targetId = matchingEntry ?? source.getLeafId();
          if (!targetId) {
            ctx.ui.notify("The matching session has no forkable entry.", "warning");
            return;
          }
          const forkPath = source.createBranchedSession(targetId);
          if (!forkPath) {
            ctx.ui.notify("Could not create a persisted session fork.", "error");
            return;
          }
          const sourceId = selected.session.id.slice(0, 8);
          const result = await ctx.switchSession(forkPath, {
            withSession: async (replacementCtx) => {
              replacementCtx.ui.notify(`Forked search match from ${sourceId}.`, "info");
            },
          });
          if (result.cancelled) {
            const removed = await removeFile(forkPath).then(() => true, () => false);
            ctx.ui.notify(
              removed
                ? "Fork switch was cancelled; the unused fork was removed."
                : `Fork switch was cancelled; unused fork remains at ${forkPath}.`,
              "warning",
            );
            return;
          }
          switched = true;
          return;
        }

        if (action === "Copy matching excerpt") {
          if (await copy(selected.snippet)) ctx.ui.notify("Matching excerpt copied.", "info");
          else {
            ctx.ui.setEditorText(selected.snippet);
            ctx.ui.notify("No supported clipboard command was available; excerpt placed in the editor.", "warning");
          }
          return;
        }

        ctx.ui.setEditorText(selected.snippet);
      } catch (error) {
        if (!switched) ctx.ui.notify(errorMessage(error), "error");
      } finally {
        // A successful switch tears down this runtime and invalidates its ctx.
        if (!switched) ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}

function selectScope(
  sessions: SessionInfo[],
  parsed: ParsedSessionSearchArgs,
  cwd: string,
  selectCurrent: typeof selectCurrentProjectSessions,
): CurrentProjectSelection {
  if (parsed.scope === "current") return selectCurrent(sessions, cwd);
  return { sessions, projectRoot: cwd, kind: "cwd" };
}

function noMatchesMessage(
  parsed: ParsedSessionSearchArgs,
  selection: CurrentProjectSelection,
  summary: SessionSearchSummary,
): string {
  const lines = [
    `No ${parsed.scope === "current" ? "current-project " : ""}sessions matched “${parsed.query}”.`,
    `scanned: ${summary.scannedSessions}${parsed.scope === "current" ? ` · project: ${compactPath(selection.projectRoot)}` : ""}`,
  ];
  if (summary.unreadableSessions > 0) lines.push(`unreadable sessions skipped: ${summary.unreadableSessions}`);
  if (summary.truncatedSessions > 0) lines.push(`sessions capped at the per-file byte limit: ${summary.truncatedSessions}`);
  if (summary.malformedLines > 0 || summary.oversizedLines > 0) {
    lines.push(`lines skipped: ${summary.malformedLines} malformed, ${summary.oversizedLines} oversized`);
  }
  return lines.join("\n");
}

function setStatus(ctx: { ui: { setStatus(key: string, value: string | undefined): void; theme: { fg(color: string, text: string): string } } }, text: string): void {
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", text));
}

function requireSessionManager(value: SessionManagerHost | undefined): SessionManagerHost {
  if (!value) throw new Error("Pi SessionManager API is unavailable in this host.");
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
